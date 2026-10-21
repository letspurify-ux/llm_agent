//! System DNS can block after a request is cancelled. Count the real lookups
//! across clients and runtimes without making Tokio shutdown wait for them.
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::{
    io,
    net::ToSocketAddrs,
    sync::{Arc, OnceLock},
};
use tokio::sync::Semaphore;

/// Lookups at once of the clients that wait for a turn (`SystemDns::waiting`).
const WAITING_WORKERS: usize = 16;

#[derive(Clone)]
pub(crate) struct SystemDns {
    workers: Arc<Semaphore>,
    /// Whether a lookup waits for a free worker instead of failing at once.
    wait: bool,
}

impl Default for SystemDns {
    fn default() -> Self {
        static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
        Self {
            workers: WORKERS.get_or_init(|| Arc::new(Semaphore::new(16))).clone(),
            wait: false,
        }
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
        static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
        Self {
            workers: WORKERS.get_or_init(|| Arc::new(Semaphore::new(WAITING_WORKERS))).clone(),
            wait: true,
        }
    }

    fn resolve_with(
        &self,
        name: String,
        lookup: impl FnOnce(&str) -> io::Result<Addrs> + Send + 'static,
    ) -> Resolving {
        let (workers, wait) = (self.workers.clone(), self.wait);
        Box::pin(async move {
            let receiver = if wait {
                let permit = workers.acquire_owned().await.map_err(io::Error::other)?;
                crate::worker::spawn_permitted(permit, "mnemoarc-dns", move || lookup(&name))?
            } else {
                crate::worker::spawn(
                    workers,
                    "mnemoarc-dns",
                    "dns_worker_capacity: previous system lookups are still running",
                    move || lookup(&name),
                )?
            };
            receiver
                .await
                .map_err(|_| io::Error::other("dns_worker_panic: system lookup interrupted"))?
                .map_err(Into::into)
        })
    }

    fn system(&self, name: &str) -> Resolving {
        self.resolve_with(name.to_owned(), |name| {
            Ok(Box::new((name, 0).to_socket_addrs()?) as Addrs)
        })
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
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    /// A lookup that answers once `released`.
    fn hung(dns: &SystemDns, released: &Arc<AtomicBool>, name: &str) -> Resolving {
        let released = released.clone();
        dns.resolve_with(name.to_owned(), move |_| {
            while !released.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(Box::new(std::iter::empty()) as Addrs)
        })
    }

    /// A waiting lookup takes no thread until one of the few is free, and
    /// one given up on meanwhile takes none.
    #[tokio::test]
    async fn waiting_lookups_take_a_worker_in_turn() {
        let workers = Arc::new(Semaphore::new(2));
        let dns = SystemDns { workers: workers.clone(), wait: true };
        let released = Arc::new(AtomicBool::new(false));
        let running: Vec<_> = (0..2).map(|i| tokio::spawn(hung(&dns, &released, &format!("h{i}")))).collect();
        while workers.available_permits() > 0 {
            tokio::task::yield_now().await;
        }
        let given_up = tokio::time::timeout(Duration::from_millis(50), hung(&dns, &released, "late")).await;
        assert!(given_up.is_err(), "it waits for a worker");
        let waiting = tokio::spawn(dns.resolve_with("next".into(), |_| Ok(Box::new(std::iter::empty()) as Addrs)));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!waiting.is_finished());
        released.store(true, Ordering::Release);
        for run in running {
            assert!(run.await.unwrap().is_ok());
        }
        assert!(waiting.await.unwrap().is_ok());
        // Both workers free again (each lets go once its thread ends): the
        // one given up on never took one.
        tokio::time::timeout(Duration::from_secs(5), async {
            while workers.available_permits() < 2 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("both workers let go");
    }

    #[tokio::test]
    async fn failing_lookups_do_not_wait() {
        let workers = Arc::new(Semaphore::new(1));
        let dns = SystemDns { workers: workers.clone(), wait: false };
        let released = Arc::new(AtomicBool::new(false));
        let running = tokio::spawn(hung(&dns, &released, "h"));
        while workers.available_permits() > 0 {
            tokio::task::yield_now().await;
        }
        let error = match hung(&dns, &released, "late").await {
            Err(error) => error.to_string(),
            Ok(_) => panic!("a full set of workers fails the lookup"),
        };
        assert!(error.starts_with("dns_worker_capacity"), "{error}");
        released.store(true, Ordering::Release);
        assert!(running.await.unwrap().is_ok());
    }
}
