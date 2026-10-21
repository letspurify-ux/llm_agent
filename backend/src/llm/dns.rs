//! System DNS can block after a request is cancelled. Count the real lookups
//! across clients and runtimes without making Tokio shutdown wait for them.
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::{
    collections::HashMap,
    io,
    net::{SocketAddr, ToSocketAddrs},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::sync::{Semaphore, watch};

/// Lookups at once of the clients that wait for a turn (`SystemDns::waiting`).
const WAITING_WORKERS: usize = 16;
const CAPACITY: &str = "dns_worker_capacity: previous system lookups are still running";

/// What a lookup found, shared with those who asked for the name meanwhile.
type Answer = Result<Vec<SocketAddr>, (io::ErrorKind, String)>;

/// A lookup under way, by the name it looks up.
struct Flight {
    id: u64,
    answer: watch::Receiver<Option<Answer>>,
}
type Flights = Arc<Mutex<HashMap<String, Flight>>>;

#[derive(Clone)]
pub(crate) struct SystemDns {
    workers: Arc<Semaphore>,
    /// Whether a lookup waits for a free worker instead of failing at once.
    wait: bool,
    flights: Flights,
}

impl Default for SystemDns {
    fn default() -> Self {
        static SHARED: OnceLock<(Arc<Semaphore>, Flights)> = OnceLock::new();
        let (workers, flights) = SHARED.get_or_init(|| (Arc::new(Semaphore::new(16)), Flights::default()));
        Self { workers: workers.clone(), wait: false, flights: flights.clone() }
    }
}

impl SystemDns {
    /// The resolver of the embedding and MCP clients, whose lookups wait
    /// their turn: an MCP server's calls each look its name up (its client
    /// keeps no idle connection), up to 62 at once. With reqwest's own
    /// resolver, each lookup took one of Tokio's blocking threads and kept
    /// it after the request that asked was given up on: a resolver that did
    /// not answer held a thread for each such request (128 for 128), threads
    /// the server keeps (`app::runtime`), and once its 512 were taken, every
    /// blocking task (an Oracle query, a source tool, a token count) waited
    /// behind them. A request given up on now stops waiting for its turn.
    pub(crate) fn waiting() -> Self {
        static SHARED: OnceLock<(Arc<Semaphore>, Flights)> = OnceLock::new();
        let (workers, flights) =
            SHARED.get_or_init(|| (Arc::new(Semaphore::new(WAITING_WORKERS)), Flights::default()));
        Self { workers: workers.clone(), wait: true, flights: flights.clone() }
    }

    fn resolve_with(
        &self,
        name: String,
        lookup: impl FnOnce(&str) -> io::Result<Vec<SocketAddr>> + Send + 'static,
    ) -> Resolving {
        let dns = self.clone();
        Box::pin(async move {
            let found = dns.answer(name, lookup).await?;
            Ok(Box::new(found.into_iter()) as Addrs)
        })
    }

    /// The addresses of `name`. Asked while a lookup of it is under way,
    /// the answer is that lookup's: one at a time, an MCP server's 62 calls
    /// waited for 62 lookups in turn — 4 s for lookups of 1 s, and longer
    /// than the embedding client's connection limit for a resolver that
    /// takes 5 s, its request queued behind them. Nothing is kept once the
    /// lookup answers: the next ask looks the name up again, as before.
    async fn answer(
        &self,
        name: String,
        lookup: impl FnOnce(&str) -> io::Result<Vec<SocketAddr>> + Send + 'static,
    ) -> io::Result<Vec<SocketAddr>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let shown = |answer: Answer| answer.map_err(|(kind, text)| io::Error::new(kind, text));
        let mut lookup = Some(lookup);
        loop {
            let joined = {
                let mut flights = self.flights.lock().unwrap_or_else(|p| p.into_inner());
                match flights.get(&name) {
                    Some(flight) => Ok((flight.id, flight.answer.clone())),
                    None => {
                        let id = NEXT.fetch_add(1, Ordering::Relaxed);
                        let (tell, answer) = watch::channel(None);
                        flights.insert(name.clone(), Flight { id, answer });
                        Err((id, tell))
                    }
                }
            };
            let (id, tell) = match joined {
                Ok((id, mut answer)) => {
                    if let Ok(told) = answer.wait_for(Option::is_some).await {
                        return shown(told.clone().expect("waited for an answer"));
                    }
                    // Its asker gave up before the lookup began (or the
                    // lookup's thread ended without a word): begin anew.
                    leave(&self.flights, &name, id);
                    continue;
                }
                Err(begun) => begun,
            };
            // The flight ends with this ask unless a thread takes it over.
            let mut ending = Leave { flights: self.flights.clone(), name: name.clone(), id, armed: true };
            let permit = if self.wait {
                self.workers.clone().acquire_owned().await.map_err(io::Error::other)?
            } else {
                match self.workers.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let _ = tell.send(Some(Err((io::ErrorKind::Other, CAPACITY.to_owned()))));
                        return Err(io::Error::other(CAPACITY));
                    }
                }
            };
            let lookup = lookup.take().expect("a lookup is begun once per ask");
            let (flights, asked) = (self.flights.clone(), name.clone());
            // A kernel call cannot be stopped: the thread keeps its worker
            // until it returns, and tells whoever still waits.
            let receiver = crate::worker::spawn_permitted(permit, "mnemoarc-dns", move || {
                let answer: Answer = lookup(&asked).map_err(|e| (e.kind(), e.to_string()));
                leave(&flights, &asked, id);
                let _ = tell.send(Some(answer.clone()));
                answer
            })?;
            ending.armed = false;
            let answer = receiver
                .await
                .map_err(|_| io::Error::other("dns_worker_panic: system lookup interrupted"))?;
            return shown(answer);
        }
    }

    fn system(&self, name: &str) -> Resolving {
        self.resolve_with(name.to_owned(), lookup)
    }

    /// The addresses of `name`, looked up as a client's are (the management
    /// DB's host, which its driver would look up on Tokio's threads).
    pub(crate) async fn addresses(&self, name: &str) -> io::Result<Vec<SocketAddr>> {
        self.answer(name.to_owned(), lookup).await
    }
}

fn lookup(name: &str) -> io::Result<Vec<SocketAddr>> {
    Ok((name, 0).to_socket_addrs()?.collect())
}

/// Removes flight `id` of `name`, if it is still the one listed.
fn leave(flights: &Flights, name: &str, id: u64) {
    let mut flights = flights.lock().unwrap_or_else(|p| p.into_inner());
    if flights.get(name).is_some_and(|flight| flight.id == id) {
        flights.remove(name);
    }
}

/// Ends a flight whose asker stopped before its lookup began.
struct Leave {
    flights: Flights,
    name: String,
    id: u64,
    armed: bool,
}

impl Drop for Leave {
    fn drop(&mut self) {
        if self.armed {
            leave(&self.flights, &self.name, self.id);
        }
    }
}

impl Resolve for SystemDns {
    fn resolve(&self, name: Name) -> Resolving {
        self.system(name.as_str())
    }
}

/// The MCP HTTP client's (reqwest 0.13, rmcp's).
impl reqwest13::dns::Resolve for SystemDns {
    fn resolve(&self, name: reqwest13::dns::Name) -> reqwest13::dns::Resolving {
        self.system(name.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicBool, AtomicUsize},
        time::Duration,
    };

    fn resolver(workers: usize, wait: bool) -> (SystemDns, Arc<Semaphore>) {
        let semaphore = Arc::new(Semaphore::new(workers));
        (SystemDns { workers: semaphore.clone(), wait, flights: Flights::default() }, semaphore)
    }

    /// A lookup that answers once `released`, counted in `lookups`.
    fn hung(dns: &SystemDns, released: &Arc<AtomicBool>, lookups: &Arc<AtomicUsize>, name: &str) -> Resolving {
        let (released, lookups) = (released.clone(), lookups.clone());
        dns.resolve_with(name.to_owned(), move |_| {
            lookups.fetch_add(1, Ordering::SeqCst);
            while !released.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(vec![SocketAddr::from(([127, 0, 0, 1], 0))])
        })
    }

    async fn taken(workers: &Semaphore) {
        while workers.available_permits() > 0 {
            tokio::task::yield_now().await;
        }
    }

    async fn all_free(workers: &Semaphore, count: usize) {
        // Each worker lets go once its thread ends, after it answered.
        tokio::time::timeout(Duration::from_secs(5), async {
            while workers.available_permits() < count {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("the workers let go");
    }

    /// A waiting lookup takes no thread until one of the few is free, and
    /// one given up on meanwhile takes none.
    #[tokio::test]
    async fn waiting_lookups_take_a_worker_in_turn() {
        let (dns, workers) = resolver(2, true);
        let (released, lookups) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
        let running: Vec<_> = (0..2).map(|i| tokio::spawn(hung(&dns, &released, &lookups, &format!("h{i}")))).collect();
        taken(&workers).await;
        let given_up = tokio::time::timeout(Duration::from_millis(50), hung(&dns, &released, &lookups, "late")).await;
        assert!(given_up.is_err(), "it waits for a worker");
        let waiting = tokio::spawn(dns.resolve_with("next".into(), |_| Ok(vec![])));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished());
        released.store(true, Ordering::Release);
        for run in running {
            assert!(run.await.unwrap().is_ok());
        }
        assert!(waiting.await.unwrap().is_ok());
        all_free(&workers, 2).await;
        assert_eq!(lookups.load(Ordering::SeqCst), 2, "the one given up on never looked up");
        assert!(dns.flights.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failing_lookups_do_not_wait() {
        let (dns, workers) = resolver(1, false);
        let (released, lookups) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
        let running = tokio::spawn(hung(&dns, &released, &lookups, "h"));
        taken(&workers).await;
        let error = match hung(&dns, &released, &lookups, "late").await {
            Err(error) => error.to_string(),
            Ok(_) => panic!("a full set of workers fails the lookup"),
        };
        assert!(error.starts_with("dns_worker_capacity"), "{error}");
        released.store(true, Ordering::Release);
        assert!(running.await.unwrap().is_ok());
        assert!(dns.flights.lock().unwrap().is_empty());
    }

    /// Asks for a name being looked up share that lookup, on one worker;
    /// once it answered, the name is looked up again.
    #[tokio::test(flavor = "multi_thread")]
    async fn asks_for_a_name_meanwhile_share_its_lookup() {
        let (dns, workers) = resolver(2, true);
        let (released, lookups) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
        let asks: Vec<_> = (0..62).map(|_| tokio::spawn(hung(&dns, &released, &lookups, "mcp.example"))).collect();
        while lookups.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        // Another name still finds a worker.
        let other = tokio::time::timeout(Duration::from_secs(5), dns.resolve_with("other".into(), |_| Ok(vec![])));
        assert!(other.await.expect("a free worker").is_ok());
        released.store(true, Ordering::Release);
        for ask in asks {
            let found: Vec<_> = ask.await.unwrap().map_err(|e| e.to_string()).unwrap().collect();
            assert_eq!(found, [SocketAddr::from(([127, 0, 0, 1], 0))]);
        }
        assert_eq!(lookups.load(Ordering::SeqCst), 1);
        assert!(hung(&dns, &released, &lookups, "mcp.example").await.is_ok());
        assert_eq!(lookups.load(Ordering::SeqCst), 2, "an answer is not kept");
        all_free(&workers, 2).await;
        assert!(dns.flights.lock().unwrap().is_empty());
    }

    /// The ask that began a lookup gave up while it waited for a worker:
    /// those who joined it look the name up themselves.
    #[tokio::test]
    async fn a_lookup_given_up_before_it_began_is_begun_again() {
        let (dns, workers) = resolver(1, true);
        let (released, lookups) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
        let busy = tokio::spawn(hung(&dns, &released, &lookups, "busy"));
        taken(&workers).await;
        let first = tokio::spawn(hung(&dns, &released, &lookups, "x"));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let joined = tokio::spawn(hung(&dns, &released, &lookups, "x"));
        tokio::time::sleep(Duration::from_millis(20)).await;
        first.abort();
        assert!(first.await.is_err_and(|e| e.is_cancelled()));
        released.store(true, Ordering::Release);
        let found = tokio::time::timeout(Duration::from_secs(5), joined).await.expect("answered");
        assert!(found.unwrap().is_ok());
        assert!(busy.await.unwrap().is_ok());
        assert_eq!(lookups.load(Ordering::SeqCst), 2, "busy and x, once");
        all_free(&workers, 1).await;
        assert!(dns.flights.lock().unwrap().is_empty());
    }

    /// Asks for a few names at random times, given up on at random, with
    /// lookups that take random times and fail at random: every ask not
    /// given up on is answered, and once all are done no flight is left and
    /// every worker is free.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn flights_end_whatever_their_asks_do() {
        use rand::Rng;
        for wait in [true, false] {
            for round in 0..20 {
                let workers = 1 + round % 4;
                let (dns, semaphore) = resolver(workers, wait);
                let asks: Vec<_> = (0..200)
                    .map(|_| {
                        let mut rng = rand::thread_rng();
                        let name = format!("n{}", rng.gen_range(0..4));
                        let (sleep, fails, give_up, start) = (
                            rng.gen_range(0..3u64),
                            rng.gen_bool(0.2),
                            rng.gen_bool(0.3).then(|| rng.gen_range(0..4u64)),
                            rng.gen_range(0..5u64),
                        );
                        let dns = dns.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(start)).await;
                            let ask = dns.resolve_with(name, move |_| {
                                std::thread::sleep(Duration::from_millis(sleep));
                                if fails { Err(io::Error::other("refused")) } else { Ok(vec![]) }
                            });
                            match give_up {
                                Some(ms) => {
                                    let _ = tokio::time::timeout(Duration::from_millis(ms), ask).await;
                                    true
                                }
                                None => tokio::time::timeout(Duration::from_secs(10), ask).await.is_ok(),
                            }
                        })
                    })
                    .collect();
                for ask in asks {
                    assert!(ask.await.unwrap(), "an ask kept waiting");
                }
                all_free(&semaphore, workers).await;
                assert!(dns.flights.lock().unwrap().is_empty(), "flights left: {:?}", dns.flights.lock().unwrap().keys().collect::<Vec<_>>());
            }
        }
    }

    /// A refused lookup (no free worker) refuses those who joined it, and
    /// leaves no flight behind.
    #[tokio::test]
    async fn a_refused_lookup_tells_those_who_joined_it() {
        let (dns, workers) = resolver(1, false);
        let (released, lookups) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicUsize::new(0)));
        let busy = tokio::spawn(hung(&dns, &released, &lookups, "busy"));
        taken(&workers).await;
        let (a, b) = tokio::join!(hung(&dns, &released, &lookups, "x"), hung(&dns, &released, &lookups, "x"));
        assert!(a.is_err() && b.is_err());
        assert!(!dns.flights.lock().unwrap().contains_key("x"));
        released.store(true, Ordering::Release);
        assert!(busy.await.unwrap().is_ok());
        assert_eq!(lookups.load(Ordering::SeqCst), 1);
    }
}
