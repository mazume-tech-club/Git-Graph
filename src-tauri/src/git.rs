use std::collections::HashMap;

use git2::{BranchType, Repository, Sort, WorktreeLockStatus};
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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub kind: RefKind,
    /// ブランチが指すコミット ID
    pub target: String,
    pub is_head: bool,
    /// 追跡しているリモートブランチ名
    pub upstream: Option<String>,
    /// HEAD に取り込み済みか（HEAD から到達できるか）
    pub merged: bool,
    /// HEAD を基準にした差分。ahead = HEAD に無いコミット数
    pub ahead: usize,
    pub behind: usize,
    pub last_commit_time: i64,
    pub last_commit_summary: String,
    pub last_commit_author: String,
    /// このブランチをチェックアウトしているワークツリーのパス
    pub worktree_path: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    /// チェックアウト中のブランチ名。detached HEAD なら None
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub is_detached: bool,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
    /// 作業ディレクトリが失われている等で、git worktree prune の対象になるか
    pub is_prunable: bool,
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

/// ブランチ名 -> それをチェックアウトしているワークツリーのパス
fn worktree_by_branch(repo: &Repository) -> HashMap<String, String> {
    let mut map = HashMap::new();

    // メインワークツリー（commondir の親）も対象に含める
    if let Some(dir) = main_workdir(repo) {
        if let Ok(main) = Repository::open(&dir) {
            if let Some(name) = checked_out_branch(&main) {
                map.insert(name, dir);
            }
        }
    }

    let Ok(names) = repo.worktrees() else {
        return map;
    };
    for name in names.iter().filter_map(|n| n.ok().flatten()) {
        let Ok(worktree) = repo.find_worktree(name) else {
            continue;
        };
        let path = worktree.path().to_string_lossy().to_string();
        if let Ok(wt_repo) = Repository::open_from_worktree(&worktree) {
            if let Some(branch) = checked_out_branch(&wt_repo) {
                map.insert(branch, path);
            }
        }
    }

    map
}

/// detached HEAD でなければ、チェックアウト中のブランチ名を返す
fn checked_out_branch(repo: &Repository) -> Option<String> {
    if repo.head_detached().unwrap_or(false) {
        return None;
    }
    repo.head().ok()?.shorthand().ok().map(str::to_string)
}

/// メインワークツリーの作業ディレクトリ。commondir は `<main>/.git` を指す
fn main_workdir(repo: &Repository) -> Option<String> {
    let common = repo.commondir();
    let dir = if common.ends_with(".git") {
        common.parent()?
    } else {
        common
    };
    Some(
        dir.to_string_lossy()
            .trim_end_matches(['/', '\\'])
            .to_string(),
    )
}

/// ローカル / リモート追跡ブランチの一覧。HEAD との関係も付けて返す。
pub fn list_branches(path: &str) -> Result<Vec<BranchInfo>, String> {
    let repo = open(path)?;
    if repo.is_empty().unwrap_or(false) {
        return Ok(Vec::new());
    }

    let head_oid = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id());
    let worktrees = worktree_by_branch(&repo);

    let mut branches = Vec::new();
    for branch_type in [BranchType::Local, BranchType::Remote] {
        let Ok(iter) = repo.branches(Some(branch_type)) else {
            continue;
        };
        for entry in iter.flatten() {
            let (branch, _) = entry;
            let Ok(Some(name)) = branch.name() else {
                continue;
            };
            let name = name.to_string();
            let Some(target) = branch.get().target() else {
                continue;
            };
            let Ok(commit) = repo.find_commit(target) else {
                continue;
            };

            // HEAD との差分。ahead が 0 なら HEAD に取り込み済み
            let (ahead, behind) = match head_oid {
                Some(head) => repo.graph_ahead_behind(target, head).unwrap_or((0, 0)),
                None => (0, 0),
            };

            let is_local = branch_type == BranchType::Local;
            branches.push(BranchInfo {
                kind: if is_local {
                    if branch.is_head() {
                        RefKind::Head
                    } else {
                        RefKind::LocalBranch
                    }
                } else {
                    RefKind::RemoteBranch
                },
                is_head: branch.is_head(),
                upstream: branch
                    .upstream()
                    .ok()
                    .and_then(|u| u.name().ok().flatten().map(str::to_string)),
                merged: head_oid.is_some() && ahead == 0,
                ahead,
                behind,
                last_commit_time: commit.time().seconds(),
                last_commit_summary: commit
                    .summary()
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string(),
                last_commit_author: commit.author().name().unwrap_or_default().to_string(),
                worktree_path: worktrees.get(&name).cloned(),
                target: target.to_string(),
                name,
            });
        }
    }

    Ok(branches)
}

/// ワークツリーの一覧。メインワークツリーを先頭に置く。
pub fn list_worktrees(path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let repo = open(path)?;
    let mut list = Vec::new();

    if let Some(dir) = main_workdir(&repo) {
        let main = Repository::open(&dir).ok();
        let (branch, head, is_detached) = match &main {
            Some(r) => (
                checked_out_branch(r),
                r.head()
                    .ok()
                    .and_then(|h| h.peel_to_commit().ok())
                    .map(|c| c.id().to_string()),
                r.head_detached().unwrap_or(false),
            ),
            None => (None, None, false),
        };
        list.push(WorktreeInfo {
            name: "(main)".to_string(),
            path: dir,
            branch,
            head,
            is_main: true,
            is_detached,
            is_locked: false,
            lock_reason: None,
            is_prunable: false,
        });
    }

    let Ok(names) = repo.worktrees() else {
        return Ok(list);
    };
    for name in names.iter().filter_map(|n| n.ok().flatten()) {
        let Ok(worktree) = repo.find_worktree(name) else {
            continue;
        };
        let (is_locked, lock_reason) = match worktree.is_locked() {
            Ok(WorktreeLockStatus::Locked(reason)) => (true, reason),
            _ => (false, None),
        };
        let wt_repo = Repository::open_from_worktree(&worktree).ok();
        let (branch, head, is_detached) = match &wt_repo {
            Some(r) => (
                checked_out_branch(r),
                r.head()
                    .ok()
                    .and_then(|h| h.peel_to_commit().ok())
                    .map(|c| c.id().to_string()),
                r.head_detached().unwrap_or(false),
            ),
            None => (None, None, false),
        };

        list.push(WorktreeInfo {
            name: name.to_string(),
            path: worktree.path().to_string_lossy().to_string(),
            branch,
            head,
            is_main: false,
            is_detached,
            is_locked,
            lock_reason,
            // 作業ディレクトリが消えている場合などを拾う
            is_prunable: worktree.validate().is_err(),
        });
    }

    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Commit, Oid, RepositoryInitOptions, Signature, Time, WorktreeAddOptions};
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

    /// fixture() に「未マージのブランチ」と「リンクされたワークツリー」を足したもの。
    ///
    /// A -- B -- D -- M (main, HEAD)
    ///       |\      /
    ///       | `- C -'      (feature: マージ済み。ワークツリー wt-feature で開く)
    ///       `--- U         (stale: 未マージ)
    ///
    /// 戻り値の 2 つ目はワークツリーの置き場所。落とすとディレクトリごと消えるので
    /// テストが終わるまで保持する必要がある。
    fn fixture_with_worktree() -> (TempDir, TempDir) {
        let dir = fixture();
        let outside = TempDir::new().unwrap();
        let repo = Repository::open(dir.path()).unwrap();

        // B から分岐したまま取り込まれていないブランチ
        let b = repo
            .revparse_single("main~2")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        repo.branch("stale", &b, false).unwrap();
        commit_on(&repo, "refs/heads/stale", "U", 6_000, &[&b]);

        // feature ブランチを別のワークツリーでチェックアウトする
        let reference = repo
            .find_branch("feature", BranchType::Local)
            .unwrap()
            .into_reference();
        let mut opts = WorktreeAddOptions::new();
        opts.reference(Some(&reference));
        let wt_path = outside.path().join("wt-feature");
        repo.worktree("wt-feature", &wt_path, Some(&opts)).unwrap();

        (dir, outside)
    }

    #[test]
    fn list_branches_reports_merge_state_against_head() {
        let (dir, _outside) = fixture_with_worktree();
        let branches = list_branches(&path_of(&dir)).unwrap();
        let by_name: HashMap<&str, &BranchInfo> =
            branches.iter().map(|b| (b.name.as_str(), b)).collect();

        let main = by_name["main"];
        assert!(main.is_head);
        assert!(main.merged);
        assert_eq!((main.ahead, main.behind), (0, 0));

        // C は M に取り込まれているので「マージ済み」
        let feature = by_name["feature"];
        assert!(!feature.is_head);
        assert!(feature.merged, "feature は main にマージ済みのはず");
        assert_eq!(feature.ahead, 0);

        // U は main のどこからも辿れない
        let stale = by_name["stale"];
        assert!(!stale.merged, "stale は未マージのはず");
        assert_eq!(stale.ahead, 1, "main に無いコミットは U の 1 件");
        assert_eq!(stale.behind, 3, "stale に無いコミットは C/D/M の 3 件");
        assert_eq!(stale.last_commit_summary, "U");
        assert_eq!(stale.last_commit_time, 6_000);
    }

    #[test]
    fn list_branches_links_branches_to_their_worktree() {
        let (dir, _outside) = fixture_with_worktree();
        let branches = list_branches(&path_of(&dir)).unwrap();
        let by_name: HashMap<&str, &BranchInfo> =
            branches.iter().map(|b| (b.name.as_str(), b)).collect();

        // main はメインワークツリー、feature はリンクされたワークツリーで開かれている
        assert!(by_name["main"].worktree_path.is_some());
        let feature_wt = by_name["feature"].worktree_path.as_deref().unwrap();
        assert!(
            feature_wt.contains("wt-feature"),
            "feature のワークツリーが取れていない: {feature_wt}"
        );
        // どこでも開かれていないブランチは None
        assert_eq!(by_name["stale"].worktree_path, None);
    }

    #[test]
    fn list_worktrees_includes_main_and_linked() {
        let (dir, _outside) = fixture_with_worktree();
        let worktrees = list_worktrees(&path_of(&dir)).unwrap();

        assert_eq!(worktrees.len(), 2, "メイン + wt-feature の 2 つ");

        let main = &worktrees[0];
        assert!(main.is_main, "メインワークツリーが先頭に来る");
        assert_eq!(main.branch.as_deref(), Some("main"));
        assert!(!main.is_detached);
        assert!(!main.is_prunable);

        let linked = &worktrees[1];
        assert!(!linked.is_main);
        assert_eq!(linked.name, "wt-feature");
        assert_eq!(linked.branch.as_deref(), Some("feature"));
        assert!(!linked.is_locked);
        assert!(linked.head.is_some());
    }

    #[test]
    fn list_worktrees_returns_main_only_without_linked_worktrees() {
        let dir = fixture();
        let worktrees = list_worktrees(&path_of(&dir)).unwrap();
        assert_eq!(worktrees.len(), 1);
        assert!(worktrees[0].is_main);
    }

    #[test]
    fn list_branches_on_empty_repository() {
        let dir = TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();
        assert!(list_branches(&path_of(&dir)).unwrap().is_empty());
    }
}
