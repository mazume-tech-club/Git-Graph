use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use git2::{
    BranchType, Delta, Diff, DiffFindOptions, DiffLineType, DiffOptions, Oid, Patch, Repository,
    Sort, Tree, WorktreeLockStatus,
};
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

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    TypeChange,
    Untracked,
    Other,
}

impl From<Delta> for ChangeStatus {
    fn from(delta: Delta) -> Self {
        match delta {
            Delta::Added => ChangeStatus::Added,
            Delta::Deleted => ChangeStatus::Deleted,
            Delta::Modified => ChangeStatus::Modified,
            Delta::Renamed => ChangeStatus::Renamed,
            Delta::Copied => ChangeStatus::Copied,
            Delta::Typechange => ChangeStatus::TypeChange,
            Delta::Untracked => ChangeStatus::Untracked,
            _ => ChangeStatus::Other,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// リネーム / コピー元のパス
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    pub insertions: usize,
    pub deletions: usize,
    pub is_binary: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub files: Vec<FileChange>,
    pub insertions: usize,
    pub deletions: usize,
    /// マージコミットを第一親と比較していることを UI で注記するため
    pub against_first_parent: bool,
}

#[derive(Serialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Addition,
    Deletion,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub content: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    /// 行数が多すぎて途中で打ち切ったか
    pub truncated: bool,
}

/// 1 ファイルあたりに返す差分行数の上限。巨大なファイルで UI が固まるのを防ぐ
const MAX_DIFF_LINES: usize = 4000;

fn tree_of<'a>(repo: &'a Repository, rev: &str) -> Result<Tree<'a>, String> {
    let oid = Oid::from_str(rev).map_err(|e| format!("コミット ID が不正です: {}", e.message()))?;
    repo.find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| e.message().to_string())
}

fn head_tree(repo: &Repository) -> Option<Tree<'_>> {
    repo.head().ok()?.peel_to_commit().ok()?.tree().ok()
}

/// 比較する 2 点から diff を組み立てる。
///
/// - `to` が None … 作業ツリーとの比較（`from` 省略時は HEAD が基準）
/// - `from` が None … `to` の第一親との比較（= そのコミットの変更内容）
/// - 両方指定 … 任意の 2 コミット間の比較
fn build_diff<'a>(
    repo: &'a Repository,
    from: Option<&str>,
    to: Option<&str>,
    pathspec: Option<&str>,
) -> Result<(Diff<'a>, bool), String> {
    let mut opts = DiffOptions::new();
    opts.context_lines(3);
    if let Some(spec) = pathspec {
        opts.pathspec(spec);
    }

    let err = |e: git2::Error| e.message().to_string();

    let (mut diff, against_first_parent) = match to {
        None => {
            let base = match from {
                Some(rev) => Some(tree_of(repo, rev)?),
                None => head_tree(repo),
            };
            opts.include_untracked(true);
            let diff = repo
                .diff_tree_to_workdir_with_index(base.as_ref(), Some(&mut opts))
                .map_err(err)?;
            (diff, false)
        }
        Some(rev) => {
            let oid = Oid::from_str(rev)
                .map_err(|e| format!("コミット ID が不正です: {}", e.message()))?;
            let commit = repo.find_commit(oid).map_err(err)?;
            let new_tree = commit.tree().map_err(err)?;
            match from {
                None => {
                    // 親が無い（ルートコミット）場合は空ツリーとの比較になる
                    let parent_tree = match commit.parent(0) {
                        Ok(parent) => Some(parent.tree().map_err(err)?),
                        Err(_) => None,
                    };
                    let diff = repo
                        .diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))
                        .map_err(err)?;
                    (diff, commit.parent_count() > 1)
                }
                Some(base) => {
                    let base_tree = tree_of(repo, base)?;
                    let diff = repo
                        .diff_tree_to_tree(Some(&base_tree), Some(&new_tree), Some(&mut opts))
                        .map_err(err)?;
                    (diff, false)
                }
            }
        }
    };

    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true);
    // リネーム検出に失敗しても差分自体は返せるので、エラーは無視する
    let _ = diff.find_similar(Some(&mut find));

    Ok((diff, against_first_parent))
}

/// 変更されたファイルの一覧と増減行数。
pub fn diff_summary(
    path: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> Result<DiffSummary, String> {
    let repo = open(path)?;
    let (diff, against_first_parent) = build_diff(&repo, from, to, None)?;

    let mut files = Vec::new();
    let mut insertions = 0;
    let mut deletions = 0;

    for (i, delta) in diff.deltas().enumerate() {
        let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();
        let (ins, del) = if is_binary {
            (0, 0)
        } else {
            Patch::from_diff(&diff, i)
                .ok()
                .flatten()
                .and_then(|p| p.line_stats().ok())
                .map(|(_context, added, removed)| (added, removed))
                .unwrap_or((0, 0))
        };
        insertions += ins;
        deletions += del;

        let as_string = |f: git2::DiffFile<'_>| f.path().map(|p| p.to_string_lossy().to_string());
        let new_path = as_string(delta.new_file());
        let old_path = as_string(delta.old_file());
        let status = ChangeStatus::from(delta.status());

        files.push(FileChange {
            path: new_path.or_else(|| old_path.clone()).unwrap_or_default(),
            old_path: match status {
                ChangeStatus::Renamed | ChangeStatus::Copied => old_path,
                _ => None,
            },
            status,
            insertions: ins,
            deletions: del,
            is_binary,
        });
    }

    Ok(DiffSummary {
        files,
        insertions,
        deletions,
        against_first_parent,
    })
}

/// 1 ファイル分の差分をハンク単位で返す。
pub fn file_diff(
    path: &str,
    from: Option<&str>,
    to: Option<&str>,
    file: &str,
) -> Result<FileDiff, String> {
    let repo = open(path)?;
    let (diff, _) = build_diff(&repo, from, to, Some(file))?;

    let mut hunks = Vec::new();
    let mut is_binary = false;
    let mut truncated = false;
    let mut line_budget = MAX_DIFF_LINES;

    for (i, delta) in diff.deltas().enumerate() {
        // pathspec はディレクトリにも一致するので、対象ファイルだけに絞り直す
        let matches = [delta.new_file().path(), delta.old_file().path()]
            .into_iter()
            .flatten()
            .any(|p| p.to_string_lossy() == file);
        if !matches {
            continue;
        }
        if delta.old_file().is_binary() || delta.new_file().is_binary() {
            is_binary = true;
            continue;
        }

        let Ok(Some(patch)) = Patch::from_diff(&diff, i) else {
            continue;
        };
        for h in 0..patch.num_hunks() {
            let Ok((hunk, _)) = patch.hunk(h) else {
                continue;
            };
            let count = patch.num_lines_in_hunk(h).unwrap_or(0);
            if count > line_budget {
                truncated = true;
                break;
            }
            line_budget -= count;

            let mut lines = Vec::with_capacity(count);
            for l in 0..count {
                let Ok(line) = patch.line_in_hunk(h, l) else {
                    continue;
                };
                let kind = match line.origin_value() {
                    DiffLineType::Addition | DiffLineType::AddEOFNL => LineKind::Addition,
                    DiffLineType::Deletion | DiffLineType::DeleteEOFNL => LineKind::Deletion,
                    _ => LineKind::Context,
                };
                lines.push(DiffLine {
                    kind,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                    content: strip_eol(&String::from_utf8_lossy(line.content())),
                });
            }
            hunks.push(DiffHunk {
                header: strip_eol(&String::from_utf8_lossy(hunk.header())),
                lines,
            });
        }
    }

    Ok(FileDiff {
        hunks,
        is_binary,
        truncated,
    })
}

/// 行末の改行だけを落とす。差分では行末の空白自体に意味があるので trim_end は使わない。
fn strip_eol(text: &str) -> String {
    let mut out = text.to_string();
    while out.ends_with(LF) || out.ends_with(CR) {
        out.pop();
    }
    out
}

const LF: char = '\u{000A}';
const CR: char = '\u{000D}';

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoFingerprint {
    /// 全 ref の名前と指す先をまとめたダイジェスト
    pub refs: String,
    pub head: Option<String>,
    pub worktrees: usize,
}

/// 変化を検知するためだけの軽い指紋。
///
/// 作業ツリーの状態は含めない。`statuses()` 相当の走査は大きいリポジトリで重く、
/// 数秒ごとに呼ぶには向かないため。未コミットの変更は別の間隔で取り直す。
pub fn fingerprint(path: &str) -> Result<RepoFingerprint, String> {
    let repo = open(path)?;

    let mut entries: Vec<String> = Vec::new();
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            let (Ok(name), Some(target)) = (reference.name(), reference.target()) else {
                continue;
            };
            entries.push(format!("{name}={target}"));
        }
    }
    // ref の列挙順は保証されないので、ダイジェストを安定させるために並べ替える
    entries.sort_unstable();

    let mut hasher = DefaultHasher::new();
    for entry in &entries {
        entry.hash(&mut hasher);
    }

    let worktrees = repo.worktrees().map(|w| w.iter().count()).unwrap_or(0);
    worktrees.hash(&mut hasher);

    Ok(RepoFingerprint {
        refs: format!("{:016x}", hasher.finish()),
        head: repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.id().to_string()),
        worktrees,
    })
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

    /// 実ファイルを持つリポジトリを作る。差分のテストには中身が要る。
    ///
    /// 1. a.txt を追加
    /// 2. a.txt を変更し、b.txt を追加
    /// 3. a.txt を c.txt にリネーム
    fn file_fixture() -> TempDir {
        let dir = TempDir::new().unwrap();
        let mut init = RepositoryInitOptions::new();
        init.initial_head("main");
        let repo = Repository::init_opts(dir.path(), &init).unwrap();

        write_and_commit(&repo, &[("a.txt", Some(A_ORIGINAL))], "a.txt を追加", 1_000);
        write_and_commit(
            &repo,
            &[("a.txt", Some(A_CHANGED)), ("b.txt", Some("b\n"))],
            "a.txt を変更し b.txt を追加",
            2_000,
        );
        write_and_commit(
            &repo,
            &[("a.txt", None), ("c.txt", Some(A_CHANGED))],
            "a.txt を c.txt にリネーム",
            3_000,
        );

        dir
    }

    const A_ORIGINAL: &str = "line1\nline2\nline3\n";
    const A_CHANGED: &str = "line1\nCHANGED\nline3\n";

    /// `content` が None のファイルは削除する
    fn write_and_commit(
        repo: &Repository,
        files: &[(&str, Option<&str>)],
        message: &str,
        seconds: i64,
    ) -> Oid {
        use std::path::Path;

        let workdir = repo.workdir().unwrap().to_path_buf();
        let mut index = repo.index().unwrap();
        for (name, content) in files {
            match content {
                Some(text) => {
                    std::fs::write(workdir.join(name), text).unwrap();
                    index.add_path(Path::new(name)).unwrap();
                }
                None => {
                    std::fs::remove_file(workdir.join(name)).unwrap();
                    index.remove_path(Path::new(name)).unwrap();
                }
            }
        }
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();

        let sig = Signature::new("Tester", "tester@example.com", &Time::new(seconds, 540)).unwrap();
        let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&Commit> = head.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .unwrap()
    }

    /// 新しい順のコミット一覧（0 番目が HEAD）
    fn commit_ids(dir: &TempDir) -> Vec<String> {
        list_commits(&path_of(dir), 100)
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect()
    }

    #[test]
    fn diff_summary_lists_changed_files_of_a_commit() {
        let dir = file_fixture();
        let ids = commit_ids(&dir);
        // ids[0] = リネーム, ids[1] = 変更 + 追加, ids[2] = 最初の追加
        let summary = diff_summary(&path_of(&dir), None, Some(&ids[1])).unwrap();

        assert!(!summary.against_first_parent);
        assert_eq!(summary.files.len(), 2);

        let by_path: HashMap<&str, &FileChange> =
            summary.files.iter().map(|f| (f.path.as_str(), f)).collect();

        let a = by_path["a.txt"];
        assert_eq!(a.status, ChangeStatus::Modified);
        assert_eq!((a.insertions, a.deletions), (1, 1));
        assert!(!a.is_binary);

        let b = by_path["b.txt"];
        assert_eq!(b.status, ChangeStatus::Added);
        assert_eq!((b.insertions, b.deletions), (1, 0));

        assert_eq!((summary.insertions, summary.deletions), (2, 1));
    }

    #[test]
    fn diff_summary_treats_root_commit_as_all_added() {
        let dir = file_fixture();
        let ids = commit_ids(&dir);
        let summary = diff_summary(&path_of(&dir), None, Some(ids.last().unwrap())).unwrap();

        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "a.txt");
        assert_eq!(summary.files[0].status, ChangeStatus::Added);
        assert_eq!(summary.files[0].insertions, 3, "3 行すべてが追加");
        assert_eq!(summary.deletions, 0);
    }

    #[test]
    fn diff_summary_detects_renames() {
        let dir = file_fixture();
        let ids = commit_ids(&dir);
        let summary = diff_summary(&path_of(&dir), None, Some(&ids[0])).unwrap();

        assert_eq!(summary.files.len(), 1, "リネームは 1 件にまとまる");
        let renamed = &summary.files[0];
        assert_eq!(renamed.status, ChangeStatus::Renamed);
        assert_eq!(renamed.path, "c.txt");
        assert_eq!(renamed.old_path.as_deref(), Some("a.txt"));
    }

    #[test]
    fn diff_summary_compares_two_arbitrary_commits() {
        let dir = file_fixture();
        let ids = commit_ids(&dir);
        // 最初のコミットと HEAD を直接比較する
        let summary =
            diff_summary(&path_of(&dir), Some(ids.last().unwrap()), Some(&ids[0])).unwrap();

        let paths: Vec<&str> = summary.files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            paths.contains(&"b.txt"),
            "途中で追加された b.txt が含まれる"
        );
        assert!(paths.contains(&"c.txt"), "リネーム後の c.txt が含まれる");
    }

    #[test]
    fn diff_summary_reports_uncommitted_changes() {
        let dir = file_fixture();
        std::fs::write(dir.path().join("c.txt"), "line1\nUNCOMMITTED\nline3\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "new\n").unwrap();

        let summary = diff_summary(&path_of(&dir), None, None).unwrap();
        let by_path: HashMap<&str, &FileChange> =
            summary.files.iter().map(|f| (f.path.as_str(), f)).collect();

        assert_eq!(by_path["c.txt"].status, ChangeStatus::Modified);
        assert_eq!(
            by_path["new.txt"].status,
            ChangeStatus::Untracked,
            "未追跡ファイルも拾う"
        );
    }

    #[test]
    fn diff_summary_flags_merge_commits() {
        let dir = fixture();
        let ids = commit_ids(&dir);
        // fixture() の HEAD はマージコミット
        let summary = diff_summary(&path_of(&dir), None, Some(&ids[0])).unwrap();
        assert!(
            summary.against_first_parent,
            "マージコミットは第一親と比較していることを示す"
        );
    }

    #[test]
    fn file_diff_returns_hunks_with_line_numbers() {
        let dir = file_fixture();
        let ids = commit_ids(&dir);
        let diff = file_diff(&path_of(&dir), None, Some(&ids[1]), "a.txt").unwrap();

        assert!(!diff.is_binary);
        assert!(!diff.truncated);
        assert_eq!(diff.hunks.len(), 1);

        let hunk = &diff.hunks[0];
        assert!(hunk.header.starts_with("@@"), "{}", hunk.header);

        let added: Vec<&str> = hunk
            .lines
            .iter()
            .filter(|l| matches!(l.kind, LineKind::Addition))
            .map(|l| l.content.as_str())
            .collect();
        let removed: Vec<&str> = hunk
            .lines
            .iter()
            .filter(|l| matches!(l.kind, LineKind::Deletion))
            .map(|l| l.content.as_str())
            .collect();
        assert_eq!(added, vec!["CHANGED"]);
        assert_eq!(removed, vec!["line2"]);

        // 追加行には新しい行番号だけ、削除行には古い行番号だけが付く
        let addition = hunk
            .lines
            .iter()
            .find(|l| matches!(l.kind, LineKind::Addition))
            .unwrap();
        assert_eq!(addition.new_lineno, Some(2));
        assert_eq!(addition.old_lineno, None);

        let context = hunk
            .lines
            .iter()
            .find(|l| matches!(l.kind, LineKind::Context))
            .unwrap();
        assert_eq!(context.old_lineno, Some(1));
        assert_eq!(context.new_lineno, Some(1));
    }

    #[test]
    fn file_diff_returns_nothing_for_unrelated_file() {
        let dir = file_fixture();
        let ids = commit_ids(&dir);
        let diff = file_diff(&path_of(&dir), None, Some(&ids[1]), "b.txt").unwrap();
        assert_eq!(diff.hunks.len(), 1, "b.txt 自身の差分は取れる");

        let none = file_diff(&path_of(&dir), None, Some(&ids[1]), "missing.txt").unwrap();
        assert!(none.hunks.is_empty());
    }

    #[test]
    fn fingerprint_changes_only_when_refs_change() {
        let dir = file_fixture();
        let before = fingerprint(&path_of(&dir)).unwrap();

        // 読み直しただけなら変わらない
        let again = fingerprint(&path_of(&dir)).unwrap();
        assert_eq!(before.refs, again.refs);
        assert_eq!(before.head, again.head);

        // 作業ツリーだけを汚しても指紋は変わらない（ref を見ていないため）
        std::fs::write(dir.path().join("untracked.txt"), "x").unwrap();
        assert_eq!(fingerprint(&path_of(&dir)).unwrap().refs, before.refs);

        // コミットすると変わる
        let repo = Repository::open(dir.path()).unwrap();
        write_and_commit(&repo, &[("d.txt", Some("d"))], "d.txt を追加", 4_000);
        let after = fingerprint(&path_of(&dir)).unwrap();
        assert_ne!(after.refs, before.refs);
        assert_ne!(after.head, before.head);
    }

    #[test]
    fn fingerprint_counts_worktrees() {
        let (dir, _outside) = fixture_with_worktree();
        assert_eq!(fingerprint(&path_of(&dir)).unwrap().worktrees, 1);
        assert_eq!(fingerprint(&path_of(&fixture())).unwrap().worktrees, 0);
    }
}
