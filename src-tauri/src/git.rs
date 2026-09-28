use std::collections::HashMap;

use git2::{BranchType, Repository, Sort};
use serde::Serialize;

/// リポジトリを開いた直後に返す概要情報。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// `.git` の親ディレクトリ（ワークツリーのルート）
    pub path: String,
    /// HEAD が指すブランチ名。detached HEAD の場合は None
    pub head_branch: Option<String>,
    /// HEAD のコミット ID。空リポジトリの場合は None
    pub head_commit: Option<String>,
    pub is_detached: bool,
    /// コミットが 1 件も無い（初期化直後）リポジトリか
    pub is_empty: bool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    Head,
    LocalBranch,
    RemoteBranch,
    Tag,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    pub name: String,
    pub kind: RefKind,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    /// author date（UNIX 秒）
    pub timestamp: i64,
    /// タイムゾーンオフセット（分）
    pub offset_minutes: i32,
    /// 親コミットの ID。先頭が第一親
    pub parents: Vec<String>,
    /// このコミットを指す ref のラベル
    pub refs: Vec<RefLabel>,
}

fn open(path: &str) -> Result<Repository, String> {
    // path 自体が .git でもワークツリーでも、上位を辿って開けるようにする
    Repository::discover(path)
        .map_err(|e| format!("リポジトリを開けません ({path}): {}", e.message()))
}

/// 指定パスの Git リポジトリを開き、概要を返す。
pub fn repo_info(path: &str) -> Result<RepoInfo, String> {
    let repo = open(path)?;

    let workdir = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();

    let is_empty = repo.is_empty().unwrap_or(false);
    let is_detached = repo.head_detached().unwrap_or(false);

    let (head_branch, head_commit) = match repo.head() {
        Ok(head) => {
            let branch = if is_detached {
                None
            } else {
                head.shorthand().ok().map(str::to_string)
            };
            let commit = head.peel_to_commit().ok().map(|c| c.id().to_string());
            (branch, commit)
        }
        // 空リポジトリでは HEAD が未解決になる
        Err(_) => (None, None),
    };

    Ok(RepoInfo {
        path: workdir,
        head_branch,
        head_commit,
        is_detached,
        is_empty,
    })
}

/// コミット ID -> そのコミットを指す ref ラベルの一覧
fn collect_refs(repo: &Repository) -> HashMap<String, Vec<RefLabel>> {
    let mut map: HashMap<String, Vec<RefLabel>> = HashMap::new();

    let mut push = |id: String, label: RefLabel| {
        map.entry(id).or_default().push(label);
    };

    // HEAD（detached のときだけ独立したラベルとして出す）
    if repo.head_detached().unwrap_or(false) {
        if let Ok(commit) = repo.head().and_then(|h| h.peel_to_commit()) {
            push(
                commit.id().to_string(),
                RefLabel {
                    name: "HEAD".to_string(),
                    kind: RefKind::Head,
                },
            );
        }
    }

    for kind in [BranchType::Local, BranchType::Remote] {
        let Ok(branches) = repo.branches(Some(kind)) else {
            continue;
        };
        for branch in branches.flatten() {
            let (branch, _) = branch;
            let Ok(Some(name)) = branch.name() else {
                continue;
            };
            let name = name.to_string();
            let Some(target) = branch.get().target() else {
                continue;
            };
            let is_head = branch.is_head();
            push(
                target.to_string(),
                RefLabel {
                    name,
                    kind: if kind == BranchType::Local {
                        if is_head {
                            RefKind::Head
                        } else {
                            RefKind::LocalBranch
                        }
                    } else {
                        RefKind::RemoteBranch
                    },
                },
            );
        }
    }

    if let Ok(tags) = repo.references_glob("refs/tags/*") {
        for tag in tags.flatten() {
            let Ok(name) = tag.shorthand().map(str::to_string) else {
                continue;
            };
            // 注釈付きタグはタグオブジェクトを指すので、コミットまで peel する
            let Ok(commit) = tag.peel_to_commit() else {
                continue;
            };
            push(
                commit.id().to_string(),
                RefLabel {
                    name,
                    kind: RefKind::Tag,
                },
            );
        }
    }

    map
}

/// 全ての ref から辿れるコミットを、トポロジ順（新しい順）で最大 `limit` 件返す。
pub fn list_commits(path: &str, limit: usize) -> Result<Vec<CommitInfo>, String> {
    let repo = open(path)?;
    if repo.is_empty().unwrap_or(false) {
        return Ok(Vec::new());
    }

    let refs = collect_refs(&repo);

    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    // TOPOLOGICAL だけだと親が子より上に来る場合があるため TIME と併用する
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(|e| e.message().to_string())?;
    walk.push_glob("refs/heads/*")
        .map_err(|e| e.message().to_string())?;
    // リモート追跡ブランチやタグにしか無いコミットも拾う
    let _ = walk.push_glob("refs/remotes/*");
    let _ = walk.push_glob("refs/tags/*");
    let _ = walk.push_head();

    let mut commits = Vec::new();
    for oid in walk {
        if commits.len() >= limit {
            break;
        }
        let Ok(oid) = oid else { continue };
        let Ok(commit) = repo.find_commit(oid) else {
            continue;
        };

        let id = commit.id().to_string();
        let author = commit.author();
        let time = commit.time();

        commits.push(CommitInfo {
            short_id: id.chars().take(7).collect(),
            summary: commit
                .summary()
                .ok()
                .flatten()
                .unwrap_or_default()
                .to_string(),
            body: commit.body().ok().flatten().unwrap_or_default().to_string(),
            author_name: author.name().unwrap_or_default().to_string(),
            author_email: author.email().unwrap_or_default().to_string(),
            timestamp: time.seconds(),
            offset_minutes: time.offset_minutes(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            refs: refs.get(&id).cloned().unwrap_or_default(),
            id,
        });
    }

    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Commit, Oid, RepositoryInitOptions, Signature, Time};
    use tempfile::TempDir;

    /// 全コミットで同じ（空の）ツリーを使う。ここで確かめたいのは履歴の形だけ。
    fn empty_tree(repo: &Repository) -> Oid {
        repo.index().unwrap().write_tree().unwrap()
    }

    fn commit_on(
        repo: &Repository,
        update_ref: &str,
        message: &str,
        seconds: i64,
        parents: &[&Commit],
    ) -> Oid {
        let sig = Signature::new("Tester", "tester@example.com", &Time::new(seconds, 540)).unwrap();
        let tree_id = empty_tree(repo);
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some(update_ref), &sig, &sig, message, &tree, parents)
            .unwrap()
    }

    /// A -- B -- D -- M (main)
    ///       \       /
    ///        `- C -'   (feature, tag v1.0)
    fn fixture() -> TempDir {
        let dir = TempDir::new().unwrap();
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = Repository::init_opts(dir.path(), &opts).unwrap();

        let a = commit_on(&repo, "HEAD", "A", 1_000, &[]);
        let a = repo.find_commit(a).unwrap();
        let b = commit_on(&repo, "HEAD", "B", 2_000, &[&a]);
        let b = repo.find_commit(b).unwrap();

        repo.branch("feature", &b, false).unwrap();
        let c = commit_on(&repo, "refs/heads/feature", "C", 3_000, &[&b]);
        let c = repo.find_commit(c).unwrap();
        let d = commit_on(&repo, "refs/heads/main", "D", 4_000, &[&b]);
        let d = repo.find_commit(d).unwrap();
        commit_on(&repo, "refs/heads/main", "M", 5_000, &[&d, &c]);

        repo.tag_lightweight("v1.0", c.as_object(), false).unwrap();

        dir
    }

    fn path_of(dir: &TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    fn ref_names(commit: &CommitInfo) -> Vec<&str> {
        let mut names: Vec<&str> = commit.refs.iter().map(|r| r.name.as_str()).collect();
        names.sort_unstable();
        names
    }

    #[test]
    fn repo_info_reports_head_branch() {
        let dir = fixture();
        let info = repo_info(&path_of(&dir)).unwrap();

        assert_eq!(info.head_branch.as_deref(), Some("main"));
        assert!(!info.is_detached);
        assert!(!info.is_empty);
        assert!(info.head_commit.is_some());
    }

    #[test]
    fn repo_info_handles_empty_repository() {
        let dir = TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();

        let info = repo_info(&path_of(&dir)).unwrap();
        assert!(info.is_empty);
        assert_eq!(info.head_commit, None);
        assert!(list_commits(&path_of(&dir), 100).unwrap().is_empty());
    }

    #[test]
    fn open_reports_error_for_non_repository() {
        let dir = TempDir::new().unwrap();
        // discover が上位ディレクトリの実リポジトリを拾わないよう、隔離した場所を使う
        let err = repo_info(&format!("{}/nope", path_of(&dir))).unwrap_err();
        assert!(err.contains("リポジトリを開けません"), "{err}");
    }

    #[test]
    fn list_commits_returns_children_before_parents() {
        let dir = fixture();
        let commits = list_commits(&path_of(&dir), 100).unwrap();

        assert_eq!(commits.len(), 5, "A/B/C/D/M の 5 件");

        let position: HashMap<&str, usize> = commits
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.as_str(), i))
            .collect();
        for (i, commit) in commits.iter().enumerate() {
            for parent in &commit.parents {
                assert!(
                    position[parent.as_str()] > i,
                    "{} の親 {} が子より前にある",
                    commit.summary,
                    parent
                );
            }
        }
    }

    #[test]
    fn list_commits_exposes_merge_parents_in_order() {
        let dir = fixture();
        let commits = list_commits(&path_of(&dir), 100).unwrap();

        let merge = &commits[0];
        assert_eq!(merge.summary, "M");
        assert_eq!(merge.parents.len(), 2, "マージコミットの親は 2 つ");

        let by_id: HashMap<&str, &CommitInfo> =
            commits.iter().map(|c| (c.id.as_str(), c)).collect();
        // 第一親が D、第二親が C であること（順序が入れ替わるとグラフが崩れる）
        assert_eq!(by_id[merge.parents[0].as_str()].summary, "D");
        assert_eq!(by_id[merge.parents[1].as_str()].summary, "C");
    }

    #[test]
    fn list_commits_attaches_branch_and_tag_labels() {
        let dir = fixture();
        let commits = list_commits(&path_of(&dir), 100).unwrap();
        let by_summary: HashMap<&str, &CommitInfo> =
            commits.iter().map(|c| (c.summary.as_str(), c)).collect();

        assert_eq!(ref_names(by_summary["M"]), vec!["main"]);
        assert_eq!(ref_names(by_summary["C"]), vec!["feature", "v1.0"]);
        assert!(by_summary["B"].refs.is_empty());

        // チェックアウト中のブランチは Head、それ以外は LocalBranch として区別する
        assert!(matches!(by_summary["M"].refs[0].kind, RefKind::Head));
        let feature = by_summary["C"]
            .refs
            .iter()
            .find(|r| r.name == "feature")
            .unwrap();
        assert!(matches!(feature.kind, RefKind::LocalBranch));
        let tag = by_summary["C"]
            .refs
            .iter()
            .find(|r| r.name == "v1.0")
            .unwrap();
        assert!(matches!(tag.kind, RefKind::Tag));
    }

    #[test]
    fn list_commits_respects_limit() {
        let dir = fixture();
        assert_eq!(list_commits(&path_of(&dir), 2).unwrap().len(), 2);
        assert_eq!(list_commits(&path_of(&dir), 0).unwrap().len(), 0);
    }

    #[test]
    fn commit_metadata_round_trips() {
        let dir = fixture();
        let commits = list_commits(&path_of(&dir), 100).unwrap();
        let merge = &commits[0];

        assert_eq!(merge.author_name, "Tester");
        assert_eq!(merge.author_email, "tester@example.com");
        assert_eq!(merge.timestamp, 5_000);
        assert_eq!(merge.offset_minutes, 540);
        assert_eq!(merge.short_id, merge.id[..7]);
    }
}
