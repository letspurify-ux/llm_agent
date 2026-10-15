//! Project settings checks. Path safety for reading is in `tools::read_path`.

use crate::config::Project;
use anyhow::{Result, bail};

/// Format rules that hold whether or not the folders exist right now (a
/// network drive may be offline at startup).
pub fn validate(p: &Project) -> Result<()> {
    let name = crate::text::js_trim(&p.name);
    if name.is_empty() || name.chars().count() > 100 {
        bail!("프로젝트 이름은 1~100자로 입력해주세요.");
    }
    if name.chars().any(char::is_control) {
        bail!("프로젝트 이름에 쓸 수 없는 문자가 있습니다.");
    }
    if p.description.chars().count() > 2000 {
        bail!("프로젝트 설명은 2,000자 이내로 입력해주세요.");
    }
    if p.root.as_os_str().is_empty() {
        bail!("프로젝트 폴더를 입력해주세요.");
    }
    crate::tools::utf8_path(&p.root)?;
    if p.docs.len() > 50 || p.include.len() > 100 || p.exclude.len() > 100 {
        bail!("참고 문서는 50개, 포함·제외 패턴은 각각 100개까지 입력할 수 있습니다.");
    }
    for doc in &p.docs {
        if doc.trim().is_empty() || doc.contains('\0') {
            bail!("참고 문서 경로가 비어 있거나 쓸 수 없는 문자가 있습니다.");
        }
    }
    for pattern in p.include.iter().chain(&p.exclude) {
        globset::Glob::new(pattern)
            .map_err(|e| anyhow::anyhow!("파일 패턴 {pattern:?}이 올바르지 않습니다: {e}"))?;
    }
    Ok(())
}

/// Checks a project's folders as the settings screen saves it: the root must
/// be a directory and every reference document a readable file inside the
/// root or given as an absolute path.
pub fn check_paths(p: &Project) -> Result<()> {
    if !p.root.is_absolute() {
        bail!("프로젝트 폴더는 절대 경로로 입력해주세요: {}", p.root.display());
    }
    if !p.root.is_dir() {
        bail!("프로젝트 폴더를 찾을 수 없습니다: {}", p.root.display());
    }
    let found = crate::tools::doc_paths(p);
    if found.len() != p.docs.len() {
        let root = p.root.canonicalize()?;
        for doc in &p.docs {
            let path = std::path::Path::new(doc.trim());
            let path = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
            if !path.is_file() {
                bail!("참고 문서를 찾을 수 없습니다: {doc}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_need_a_name_folder_and_valid_patterns() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "# x").unwrap();
        let mut p = Project {
            name: "app".into(),
            root: dir.path().into(),
            docs: vec!["README.md".into()],
            exclude: vec!["**/*.log".into()],
            ..Default::default()
        };
        validate(&p).unwrap();
        check_paths(&p).unwrap();
        p.docs.push("missing.md".into());
        assert!(check_paths(&p).is_err());
        p.docs.pop();
        p.include = vec!["[".into()];
        assert!(validate(&p).is_err());
        p.include.clear();
        p.name = " ".into();
        assert!(validate(&p).is_err());
    }
}
