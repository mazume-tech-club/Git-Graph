use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Mutex, OnceLock};

use git2::{
    BranchType, Config, ConfigLevel, Delta, Diff, DiffFindOptions, DiffLineType, DiffOptions,
    ErrorCode, Oid, Patch, Repository, Sort, StatusOptions, Tree, WorktreeLockStatus,
};
use serde::Serialize;

/// リポジトリを開いた直後に返す概要情報。
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// `.git` の親ディレクトリ（ワークツリーのルート）
    pub path: String,
    /// メインワークツリーのパス。`path` がリンクされたワークツリーのときだけ異なる。
    /// 登録リポジトリの単位はこちら
    pub main_path: String,
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
    /// マージ基準に取り込み済みか（マージ基準から到達できるか）
    pub merged: bool,
    /// マージ基準との差分。ahead = マージ基準に無いコミット数
    pub ahead: usize,
    pub behind: usize,
    /// このブランチ自身がマージ基準か
    pub is_merge_base: bool,
    /// 上流に無いコミットがあるか（上流が無いローカルブランチも true）。リモート追跡ブランチは false
    pub unpushed: bool,
    pub last_commit_time: i64,
    pub last_commit_summary: String,
    pub last_commit_author: String,
    /// `git branch --edit-description` で設定される説明
    pub description: Option<String>,
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
    /// チェックアウト中のブランチに付けられた説明
    pub description: Option<String>,
    /// HEAD のコミットメッセージ（1 行目）
    pub head_summary: Option<String>,
    pub head_time: Option<i64>,
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
        main_path: main_workdir(&repo).unwrap_or_else(|| workdir.clone()),
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
/// コミット履歴を新しい順に取得する。
///
/// `start` を指定すると、そのブランチ（またはコミット）から辿れるものだけに絞る
/// （ブランチビュー用）。省略時は全 ref から辿る。
pub fn list_commits(
    path: &str,
    limit: usize,
    start: Option<&str>,
) -> Result<Vec<CommitInfo>, String> {
    let repo = open(path)?;
    if repo.is_empty().unwrap_or(false) {
        return Ok(Vec::new());
    }

    let refs = collect_refs(&repo);

    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    // TOPOLOGICAL だけだと親が子より上に来る場合があるため TIME と併用する
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
        .map_err(|e| e.message().to_string())?;
    match start {
        Some(spec) => {
            let oid = repo
                .revparse_single(spec)
                .and_then(|o| o.peel_to_commit())
                .map(|c| c.id())
                .map_err(|e| format!("ブランチが見つかりません ({spec}): {}", e.message()))?;
            walk.push(oid).map_err(|e| e.message().to_string())?;
        }
        None => {
            walk.push_glob("refs/heads/*")
                .map_err(|e| e.message().to_string())?;
            // リモート追跡ブランチやタグにしか無いコミットも拾う
            let _ = walk.push_glob("refs/remotes/*");
            let _ = walk.push_glob("refs/tags/*");
            let _ = walk.push_head();
        }
    }

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

/// ブランチのメモを読むための設定。一覧の処理中に何度も開き直さないよう
/// 1 回だけ開き、スナップショットにして使う。
fn config_snapshot(repo: &Repository) -> Option<Config> {
    repo.config().ok()?.snapshot().ok()
}

/// `git branch --edit-description` で設定された説明を読む。
/// 未設定なら None。空文字も None として扱う。
fn branch_description(config: Option<&Config>, branch: &str) -> Option<String> {
    let text = config?
        .get_string(&format!("branch.{branch}.description"))
        .ok()?;
    let text = text.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
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

/// ahead/behind の計算結果のキャッシュ。
///
/// 2 つのコミット間の ahead/behind は履歴だけで決まり、コミット ID は内容から
/// 定まるので、(ブランチ先端, 基準) のペアが同じなら答えも同じ。ブランチが
/// 多いリポジトリでは 1 本ごとに履歴を辿るのが一覧取得で一番重く、自動更新の
/// たびに同じ計算を繰り返していたのでここで覚えておく。
type AheadBehindCache = HashMap<(Oid, Oid), (usize, usize)>;
static AHEAD_BEHIND_CACHE: OnceLock<Mutex<AheadBehindCache>> = OnceLock::new();

/// キャッシュがこれを超えたら捨てて作り直す。無限に増えないようにするだけで、
/// 普通の使い方でここまで溜まることはない
const AHEAD_BEHIND_CACHE_LIMIT: usize = 8192;

/// `local` が `upstream` に対して何コミット進んでいる / 遅れているか。
/// 結果はプロセス内でキャッシュする。
fn ahead_behind(repo: &Repository, local: Oid, upstream: Oid) -> (usize, usize) {
    if local == upstream {
        return (0, 0);
    }
    let cache = AHEAD_BEHIND_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(found) = map.get(&(local, upstream)) {
            return *found;
        }
    }
    // 失敗（コミットが見つからない等）は覚えない。別のリポジトリでは解決できるかもしれない
    let Ok(result) = repo.graph_ahead_behind(local, upstream) else {
        return (0, 0);
    };
    if let Ok(mut map) = cache.lock() {
        if map.len() >= AHEAD_BEHIND_CACHE_LIMIT {
            map.clear();
        }
        map.insert((local, upstream), result);
    }
    result
}

/// マージ基準の決まり方
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeBaseSource {
    /// 設定でリポジトリごとに指定されたもの
    Setting,
    /// main / master / develop の順で見つかったもの
    Auto,
    /// 統合ブランチが見つからず HEAD を使っている
    Head,
}

/// 「取り込まれたか」を判定する相手となる統合ブランチ。
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MergeBaseInfo {
    /// ローカルブランチ名。HEAD を使うときは None
    pub name: Option<String>,
    pub commit: Option<String>,
    pub source: MergeBaseSource,
    /// 設定で指定された名前がローカルブランチとして存在しなかったか
    pub setting_missing: bool,
}

/// マージ基準の自動検出で試す順。ローカルブランチだけを見る。
/// リモートの既定ブランチ（origin/HEAD）は、ローカルで取り込んだが push していない
/// ものを未マージと誤判定するので使わない
const MERGE_BASE_CANDIDATES: [&str; 3] = ["main", "master", "develop"];

fn local_branch_oid(repo: &Repository, name: &str) -> Option<Oid> {
    repo.find_branch(name, BranchType::Local)
        .ok()
        .and_then(|b| b.get().target())
}

/// マージ基準を決める。`preferred` は設定で指定された名前。
pub fn merge_base_info(path: &str, preferred: Option<&str>) -> Result<MergeBaseInfo, String> {
    let repo = open(path)?;
    Ok(resolve_merge_base(&repo, preferred))
}

fn resolve_merge_base(repo: &Repository, preferred: Option<&str>) -> MergeBaseInfo {
    let mut setting_missing = false;
    if let Some(name) = preferred.map(str::trim).filter(|n| !n.is_empty()) {
        if let Some(oid) = local_branch_oid(repo, name) {
            return MergeBaseInfo {
                name: Some(name.to_string()),
                commit: Some(oid.to_string()),
                source: MergeBaseSource::Setting,
                setting_missing: false,
            };
        }
        setting_missing = true;
    }
    for name in MERGE_BASE_CANDIDATES {
        if let Some(oid) = local_branch_oid(repo, name) {
            return MergeBaseInfo {
                name: Some(name.to_string()),
                commit: Some(oid.to_string()),
                source: MergeBaseSource::Auto,
                setting_missing,
            };
        }
    }
    MergeBaseInfo {
        name: None,
        commit: repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.id().to_string()),
        source: MergeBaseSource::Head,
        setting_missing,
    }
}

/// 2 つのコミットの共通祖先。無ければ None（履歴がつながっていない）
pub fn merge_base_commit(path: &str, a: &str, b: &str) -> Result<Option<String>, String> {
    let repo = open(path)?;
    let parse =
        |s: &str| Oid::from_str(s).map_err(|e| format!("コミット ID が不正です: {}", e.message()));
    Ok(repo
        .merge_base(parse(a)?, parse(b)?)
        .ok()
        .map(|oid| oid.to_string()))
}

/// ローカル / リモート追跡ブランチの一覧。マージ基準との関係も付けて返す。
///
/// `merge_base` は設定で指定されたマージ基準の名前。省略時や存在しないときは自動検出する。
pub fn list_branches(path: &str, merge_base: Option<&str>) -> Result<Vec<BranchInfo>, String> {
    let repo = open(path)?;
    if repo.is_empty().unwrap_or(false) {
        return Ok(Vec::new());
    }

    let base = resolve_merge_base(&repo, merge_base);
    let base_oid = base.commit.as_deref().and_then(|c| Oid::from_str(c).ok());
    let worktrees = worktree_by_branch(&repo);
    let config = config_snapshot(&repo);

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

            // マージ基準との差分。ahead が 0 なら取り込み済み
            let (ahead, behind) = match base_oid {
                Some(base) => ahead_behind(&repo, target, base),
                None => (0, 0),
            };

            let is_local = branch_type == BranchType::Local;
            let is_merge_base = is_local && base.name.as_deref() == Some(name.as_str());
            let upstream_branch = branch.upstream().ok();
            // 上流が無い、または上流に無いコミットがあれば「未 push」
            let unpushed = is_local
                && match upstream_branch.as_ref().and_then(|u| u.get().target()) {
                    Some(up) => ahead_behind(&repo, target, up).0 > 0,
                    None => true,
                };
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
                upstream: upstream_branch
                    .as_ref()
                    .and_then(|u| u.name().ok().flatten().map(str::to_string)),
                merged: base_oid.is_some() && ahead == 0,
                ahead,
                behind,
                is_merge_base,
                unpushed,
                last_commit_time: commit.time().seconds(),
                last_commit_summary: commit
                    .summary()
                    .ok()
                    .flatten()
                    .unwrap_or_default()
                    .to_string(),
                last_commit_author: commit.author().name().unwrap_or_default().to_string(),
                // 説明はローカルブランチにしか設定できない
                description: if is_local {
                    branch_description(config.as_ref(), &name)
                } else {
                    None
                },
                worktree_path: worktrees.get(&name).cloned(),
                target: target.to_string(),
                name,
            });
        }
    }

    Ok(branches)
}

/// ワークツリーが今どこを指しているか
struct HeadInfo {
    branch: Option<String>,
    id: Option<String>,
    detached: bool,
    summary: Option<String>,
    time: Option<i64>,
}

fn head_info(repo: &Repository) -> HeadInfo {
    let commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let (summary, time) = match &commit {
        Some(c) => (
            c.summary().ok().flatten().map(str::to_string),
            Some(c.time().seconds()),
        ),
        None => (None, None),
    };

    HeadInfo {
        branch: checked_out_branch(repo),
        id: commit.map(|c| c.id().to_string()),
        detached: repo.head_detached().unwrap_or(false),
        summary,
        time,
    }
}

/// ワークツリーの一覧。メインワークツリーを先頭に置く。
pub fn list_worktrees(path: &str) -> Result<Vec<WorktreeInfo>, String> {
    let repo = open(path)?;
    let config = config_snapshot(&repo);
    let mut list = Vec::new();

    if let Some(dir) = main_workdir(&repo) {
        let head = match Repository::open(&dir) {
            Ok(main) => head_info(&main),
            Err(_) => HeadInfo {
                branch: None,
                id: None,
                detached: false,
                summary: None,
                time: None,
            },
        };
        list.push(WorktreeInfo {
            name: "(main)".to_string(),
            path: dir,
            description: head
                .branch
                .as_deref()
                .and_then(|b| branch_description(config.as_ref(), b)),
            branch: head.branch,
            head: head.id,
            is_main: true,
            is_detached: head.detached,
            is_locked: false,
            lock_reason: None,
            is_prunable: false,
            head_summary: head.summary,
            head_time: head.time,
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
        let head = match Repository::open_from_worktree(&worktree) {
            Ok(wt_repo) => head_info(&wt_repo),
            Err(_) => HeadInfo {
                branch: None,
                id: None,
                detached: false,
                summary: None,
                time: None,
            },
        };

        list.push(WorktreeInfo {
            name: name.to_string(),
            path: worktree.path().to_string_lossy().to_string(),
            description: head
                .branch
                .as_deref()
                .and_then(|b| branch_description(config.as_ref(), b)),
            branch: head.branch,
            head: head.id,
            is_main: false,
            is_detached: head.detached,
            is_locked,
            lock_reason,
            // 作業ディレクトリが消えている場合などを拾う
            is_prunable: worktree.validate().is_err(),
            head_summary: head.summary,
            head_time: head.time,
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

    // ワークツリー数はダイジェストに混ぜず別の項目にする。
    // フロントが「ワークツリーだけ変わった」と判別して、一覧だけ取り直せるようにするため
    let worktrees = repo.worktrees().map(|w| w.iter().count()).unwrap_or(0);

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

/// 作業ツリーで変更されているファイルの数（未追跡を含む）。
///
/// 一覧の「未コミット」行に件数を出すためだけに定期的に呼ぶ。`diff_summary` と
/// 違って差分の中身（増減行数）は計算しないので、変更ファイルが大きくても軽い。
/// 未追跡ディレクトリは中を辿らず 1 件と数える（`diff_summary` と同じ数え方）。
pub fn worktree_change_count(path: &str) -> Result<usize, String> {
    let repo = open(path)?;
    change_count(&repo)
}

fn change_count(repo: &Repository) -> Result<usize, String> {
    if repo.is_bare() {
        return Ok(0);
    }
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false)
        .exclude_submodules(true)
        // 読み取り専用アプリなので index のキャッシュは書き戻さない
        .update_index(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    Ok(statuses.iter().filter(|s| !s.status().is_empty()).count())
}

/// ワークツリー 1 つ分の未コミット変更の件数
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChanges {
    pub path: String,
    /// 変更ファイル数。ワークツリーを開けなかったときは None
    pub changes: Option<usize>,
}

/// 全ワークツリー（メイン含む）の未コミット変更の件数。
///
/// ブランチの主状態「作業中」（ワークツリーで開かれていて未コミット変更がある）を
/// 決めるために、読み込み時と 30 秒ごとに呼ぶ。`list_worktrees` と同じ順で返す。
pub fn list_worktree_changes(path: &str) -> Result<Vec<WorktreeChanges>, String> {
    let repo = open(path)?;
    let mut list = Vec::new();

    if let Some(dir) = main_workdir(&repo) {
        let changes = Repository::open(&dir)
            .ok()
            .and_then(|main| change_count(&main).ok());
        list.push(WorktreeChanges { path: dir, changes });
    }

    let Ok(names) = repo.worktrees() else {
        return Ok(list);
    };
    for name in names.iter().filter_map(|n| n.ok().flatten()) {
        let Ok(worktree) = repo.find_worktree(name) else {
            continue;
        };
        let changes = Repository::open_from_worktree(&worktree)
            .ok()
            .and_then(|wt| change_count(&wt).ok());
        list.push(WorktreeChanges {
            path: worktree.path().to_string_lossy().to_string(),
            changes,
        });
    }
    Ok(list)
}

/// ホームに出すリポジトリ 1 件分の要約
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoOverview {
    pub path: String,
    pub main_path: String,
    /// 表示名（メインワークツリーのディレクトリ名）
    pub name: String,
    pub head_branch: Option<String>,
    pub is_detached: bool,
    pub merge_base: MergeBaseInfo,
    /// 未マージのローカルブランチ数（マージ基準自身は数えない）
    pub unmerged: usize,
    /// 作業中（ワークツリーで開いていて未コミット変更あり）のローカルブランチ数
    pub working: usize,
    /// ワークツリー数（メイン含む）
    pub worktrees: usize,
}

/// ホーム用の要約。ブランチ一覧と全ワークツリーの変更件数から数える。
/// 主状態の定義はフロントの `branchState.ts` と同じ（作業中 > 未マージ > マージ済み）。
pub fn repo_overview(path: &str, merge_base: Option<&str>) -> Result<RepoOverview, String> {
    let info = repo_info(path)?;
    let repo = open(path)?;
    let base = resolve_merge_base(&repo, merge_base);
    let branches = list_branches(path, merge_base)?;
    let changes = list_worktree_changes(path)?;
    let dirty: HashMap<String, usize> = changes
        .iter()
        .map(|c| (normalize_path(&c.path), c.changes.unwrap_or(0)))
        .collect();

    let mut unmerged = 0;
    let mut working = 0;
    for b in branches.iter().filter(|b| b.kind != RefKind::RemoteBranch) {
        if b.is_merge_base {
            continue;
        }
        let is_working = b
            .worktree_path
            .as_deref()
            .map(|p| dirty.get(&normalize_path(p)).copied().unwrap_or(0) > 0)
            .unwrap_or(false);
        if is_working {
            working += 1;
        } else if !b.merged {
            unmerged += 1;
        }
    }

    let name = std::path::Path::new(&info.main_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| info.main_path.clone());

    Ok(RepoOverview {
        path: info.path,
        main_path: info.main_path,
        name,
        head_branch: info.head_branch,
        is_detached: info.is_detached,
        merge_base: base,
        unmerged,
        working,
        worktrees: changes.len(),
    })
}

/// パス比較用。区切り文字と末尾の区切り、大文字小文字の違いを吸収する
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// ブランチの説明を設定する。空文字や None のときは設定を消す。
///
/// 書き込むのはリポジトリ配下の `.git/config` だけで、履歴には触れない。
/// キーは `branch.<name>.description` に固定しており、任意の設定は書けない。
pub fn set_branch_description(
    path: &str,
    branch: &str,
    description: Option<&str>,
) -> Result<(), String> {
    let repo = open(path)?;

    // 説明を付けられるのはローカルブランチだけ。存在確認も兼ねる
    repo.find_branch(branch, BranchType::Local)
        .map_err(|_| format!("ローカルブランチが見つかりません: {branch}"))?;

    let key = format!("branch.{branch}.description");
    let mut config = repo
        .config()
        .and_then(|c| c.open_level(ConfigLevel::Local))
        .map_err(|e| format!("設定を開けません: {}", e.message()))?;

    match description.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => config
            .set_str(&key, text)
            .map_err(|e| format!("説明を保存できません: {}", e.message())),
        None => match config.remove(&key) {
            // もともと未設定なら消す必要が無いので成功として扱う
            Err(e) if e.code() == ErrorCode::NotFound => Ok(()),
            Err(e) => Err(format!("説明を削除できません: {}", e.message())),
            Ok(()) => Ok(()),
        },
    }
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
        assert!(list_commits(&path_of(&dir), 100, None).unwrap().is_empty());
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
        let commits = list_commits(&path_of(&dir), 100, None).unwrap();

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
        let commits = list_commits(&path_of(&dir), 100, None).unwrap();

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
        let commits = list_commits(&path_of(&dir), 100, None).unwrap();
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
        assert_eq!(list_commits(&path_of(&dir), 2, None).unwrap().len(), 2);
        assert_eq!(list_commits(&path_of(&dir), 0, None).unwrap().len(), 0);
    }

    #[test]
    fn commit_metadata_round_trips() {
        let dir = fixture();
        let commits = list_commits(&path_of(&dir), 100, None).unwrap();
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
    fn list_branches_reports_merge_state_against_merge_base() {
        let (dir, _outside) = fixture_with_worktree();
        let branches = list_branches(&path_of(&dir), None).unwrap();
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
        let branches = list_branches(&path_of(&dir), None).unwrap();
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
        assert!(list_branches(&path_of(&dir), None).unwrap().is_empty());
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
        list_commits(&path_of(dir), 100, None)
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

    #[test]
    fn list_commits_can_start_from_one_branch() {
        let (dir, _outside) = fixture_with_worktree();
        let path = path_of(&dir);

        // stale（U ← B ← A）から辿ると 3 件。main 側の C/D/M は含まない
        let from_stale = list_commits(&path, 100, Some("stale")).unwrap();
        let summaries: Vec<&str> = from_stale.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(summaries, vec!["U", "B", "A"]);

        // 全体では A/B/C/D/M/U の 6 件
        assert_eq!(list_commits(&path, 100, None).unwrap().len(), 6);

        // 無いブランチはエラー
        assert!(list_commits(&path, 100, Some("no-such")).is_err());
    }

    #[test]
    fn repo_info_reports_main_path_from_linked_worktree() {
        let (dir, outside) = fixture_with_worktree();
        let wt = outside.path().join("wt-feature");
        let info = repo_info(&wt.to_string_lossy()).unwrap();
        assert_ne!(
            info.path, info.main_path,
            "ワークツリーから開くと path と main_path は違う"
        );
        assert_eq!(
            normalize_path(&info.main_path),
            normalize_path(&path_of(&dir))
        );
        assert_eq!(info.head_branch.as_deref(), Some("feature"));

        let main = repo_info(&path_of(&dir)).unwrap();
        assert_eq!(main.path, main.main_path);
    }

    #[test]
    fn repo_overview_counts_states() {
        let (dir, outside) = fixture_with_worktree();
        let path = path_of(&dir);

        // 汚す前: stale が未マージ 1、作業中 0
        let clean = repo_overview(&path, None).unwrap();
        assert_eq!(clean.merge_base.name.as_deref(), Some("main"));
        assert_eq!((clean.unmerged, clean.working, clean.worktrees), (1, 0, 2));
        assert_eq!(clean.head_branch.as_deref(), Some("main"));
        assert!(!clean.name.is_empty());

        // feature のワークツリーを汚すと作業中 1（feature はマージ済みだが作業中が優先）
        std::fs::write(outside.path().join("wt-feature/new.txt"), "x").unwrap();
        let dirty = repo_overview(&path, None).unwrap();
        assert_eq!((dirty.unmerged, dirty.working), (1, 1));

        // 基準を stale にすると main が未マージ側に回る
        let other = repo_overview(&path, Some("stale")).unwrap();
        assert_eq!(other.merge_base.name.as_deref(), Some("stale"));
        assert_eq!(other.unmerged, 1, "main が未マージ、feature は作業中");
        assert_eq!(other.working, 1);
    }

    #[test]
    fn merge_base_is_detected_in_fixed_order_and_setting_wins() {
        let dir = fixture();
        let path = path_of(&dir);

        // 指定が無ければ main
        let auto = merge_base_info(&path, None).unwrap();
        assert_eq!(auto.name.as_deref(), Some("main"));
        assert_eq!(auto.source, MergeBaseSource::Auto);
        assert!(!auto.setting_missing);

        // 設定で存在するブランチを指定すればそれ
        let set = merge_base_info(&path, Some("feature")).unwrap();
        assert_eq!(set.name.as_deref(), Some("feature"));
        assert_eq!(set.source, MergeBaseSource::Setting);

        // 存在しない名前なら自動検出に戻り、その旨を伝える
        let missing = merge_base_info(&path, Some("no-such")).unwrap();
        assert_eq!(missing.name.as_deref(), Some("main"));
        assert_eq!(missing.source, MergeBaseSource::Auto);
        assert!(missing.setting_missing);

        // 空白だけの指定は無指定と同じ
        assert_eq!(
            merge_base_info(&path, Some("  ")).unwrap().source,
            MergeBaseSource::Auto
        );
    }

    #[test]
    fn merge_base_falls_back_to_head_without_integration_branch() {
        let dir = TempDir::new().unwrap();
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("trunk");
        let repo = Repository::init_opts(dir.path(), &opts).unwrap();
        commit_on(&repo, "HEAD", "A", 1_000, &[]);

        let info = merge_base_info(&path_of(&dir), None).unwrap();
        assert_eq!(info.name, None);
        assert_eq!(info.source, MergeBaseSource::Head);
        assert!(info.commit.is_some());
    }

    #[test]
    fn list_branches_judges_against_given_merge_base() {
        let (dir, _outside) = fixture_with_worktree();
        // 基準を stale にすると、main は stale に無い C/D/M の 3 件分 ahead で未マージ扱い
        let branches = list_branches(&path_of(&dir), Some("stale")).unwrap();
        let by_name: HashMap<&str, &BranchInfo> =
            branches.iter().map(|b| (b.name.as_str(), b)).collect();

        assert!(by_name["stale"].is_merge_base);
        assert!(by_name["stale"].merged);
        assert!(!by_name["main"].is_merge_base);
        assert!(!by_name["main"].merged);
        assert_eq!((by_name["main"].ahead, by_name["main"].behind), (3, 1));
    }

    #[test]
    fn list_branches_flags_unpushed_against_upstream() {
        let dir = fixture();
        let path = path_of(&dir);
        let repo = Repository::open(dir.path()).unwrap();

        // 上流が無いローカルブランチは未 push
        let before = list_branches(&path, None).unwrap();
        assert!(before.iter().find(|b| b.name == "main").unwrap().unpushed);

        // main と同じ位置にリモート追跡ブランチを作って上流にすると push 済み
        // （上流の設定にはリモートの定義が要る。URL は使わない）
        repo.remote("origin", "https://example.invalid/repo.git")
            .unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.reference("refs/remotes/origin/main", head.id(), true, "")
            .unwrap();
        repo.find_branch("main", BranchType::Local)
            .unwrap()
            .set_upstream(Some("origin/main"))
            .unwrap();
        let synced = list_branches(&path, None).unwrap();
        let by_name: HashMap<&str, &BranchInfo> =
            synced.iter().map(|b| (b.name.as_str(), b)).collect();
        assert!(!by_name["main"].unpushed);
        assert_eq!(by_name["main"].upstream.as_deref(), Some("origin/main"));
        // リモート追跡ブランチ自体は対象外
        assert!(!by_name["origin/main"].unpushed);

        // 上流を 1 つ前に戻すと、上流に無いコミットがあるので未 push
        let parent = head.parent(0).unwrap();
        repo.reference("refs/remotes/origin/main", parent.id(), true, "")
            .unwrap();
        let behind = list_branches(&path, None).unwrap();
        assert!(behind.iter().find(|b| b.name == "main").unwrap().unpushed);
    }

    #[test]
    fn merge_base_commit_finds_common_ancestor() {
        let dir = fixture();
        let path = path_of(&dir);
        let repo = Repository::open(dir.path()).unwrap();
        // D (main^) と C (feature) は B から分かれている
        let d = repo.revparse_single("main^").unwrap().id().to_string();
        let feature = repo.revparse_single("feature").unwrap().id().to_string();
        let b = repo.revparse_single("main~2").unwrap().id().to_string();
        assert_eq!(merge_base_commit(&path, &d, &feature).unwrap(), Some(b));

        // C は M に取り込まれているので、M と C の共通祖先は C 自身
        let main = repo.revparse_single("main").unwrap().id().to_string();
        assert_eq!(
            merge_base_commit(&path, &main, &feature).unwrap(),
            Some(feature.clone())
        );
        assert!(merge_base_commit(&path, "zzz", &feature).is_err());
    }

    #[test]
    fn list_worktree_changes_counts_each_worktree() {
        let (dir, outside) = fixture_with_worktree();
        let path = path_of(&dir);

        let clean = list_worktree_changes(&path).unwrap();
        assert_eq!(clean.len(), 2);
        assert!(clean.iter().all(|w| w.changes == Some(0)));

        // 別ワークツリーだけを汚す
        std::fs::write(outside.path().join("wt-feature/new.txt"), "x").unwrap();
        let dirty = list_worktree_changes(&path).unwrap();
        let by_path: HashMap<&str, Option<usize>> =
            dirty.iter().map(|w| (w.path.as_str(), w.changes)).collect();
        let wt = dirty
            .iter()
            .find(|w| w.path.contains("wt-feature"))
            .unwrap();
        assert_eq!(wt.changes, Some(1));
        // メインの方は変わらない（ワークツリーごとに独立して数える）
        let main = dirty
            .iter()
            .find(|w| !w.path.contains("wt-feature"))
            .unwrap();
        assert_eq!(by_path[main.path.as_str()], Some(0));
    }

    #[test]
    fn fingerprint_refs_digest_ignores_worktree_count() {
        // ワークツリーの増減は worktrees の項目だけに出て、refs のダイジェストは変えない。
        // フロントが「ワークツリーだけ変わった」と見分けて一覧だけ取り直すため
        let (dir, _outside) = fixture_with_worktree();
        let path = path_of(&dir);
        let before = fingerprint(&path).unwrap();

        let repo = Repository::open(dir.path()).unwrap();
        let mut prune = git2::WorktreePruneOptions::new();
        prune.valid(true).working_tree(true);
        repo.find_worktree("wt-feature")
            .unwrap()
            .prune(Some(&mut prune))
            .unwrap();

        let after = fingerprint(&path).unwrap();
        assert_eq!(after.worktrees, 0);
        assert_eq!(after.refs, before.refs);
    }

    #[test]
    fn worktree_change_count_matches_diff_summary() {
        let dir = file_fixture();
        let path = path_of(&dir);
        assert_eq!(worktree_change_count(&path).unwrap(), 0);

        // 変更 1 件 + 未追跡ファイル 1 件 + 未追跡ディレクトリ 1 件（中は辿らない）
        std::fs::write(dir.path().join("c.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("untracked.txt"), "x").unwrap();
        std::fs::create_dir(dir.path().join("newdir")).unwrap();
        std::fs::write(dir.path().join("newdir/one.txt"), "1").unwrap();
        std::fs::write(dir.path().join("newdir/two.txt"), "2").unwrap();

        let count = worktree_change_count(&path).unwrap();
        assert_eq!(count, 3);
        assert_eq!(count, diff_summary(&path, None, None).unwrap().files.len());
    }

    #[test]
    fn ahead_behind_is_stable_across_cache_hits() {
        let dir = fixture();
        let path = path_of(&dir);
        // 1 回目で計算し、2 回目はキャッシュから返る。どちらも同じ値であること
        let first = list_branches(&path, None).unwrap();
        let second = list_branches(&path, None).unwrap();
        for (a, b) in first.iter().zip(second.iter()) {
            assert_eq!((a.ahead, a.behind), (b.ahead, b.behind), "{}", a.name);
        }
        let feature = first.iter().find(|b| b.name == "feature").unwrap();
        // feature(C) は main(M) に取り込み済み。M, D の 2 つ分だけ遅れている
        assert_eq!((feature.ahead, feature.behind), (0, 2));
    }

    #[test]
    fn branch_and_worktree_expose_descriptions() {
        let (dir, _outside) = fixture_with_worktree();
        let repo = Repository::open(dir.path()).unwrap();
        repo.config()
            .unwrap()
            .set_str("branch.feature.description", "詳細ペインの実装")
            .unwrap();
        repo.config()
            .unwrap()
            .set_str("branch.stale.description", "   ")
            .unwrap();

        let branches = list_branches(&path_of(&dir), None).unwrap();
        let by_name: HashMap<&str, &BranchInfo> =
            branches.iter().map(|b| (b.name.as_str(), b)).collect();

        assert_eq!(
            by_name["feature"].description.as_deref(),
            Some("詳細ペインの実装")
        );
        assert_eq!(
            by_name["stale"].description, None,
            "空白だけの説明は無しとして扱う"
        );
        assert_eq!(by_name["main"].description, None, "未設定は None");

        // ワークツリーには、そこで開いているブランチの説明が付く
        let worktrees = list_worktrees(&path_of(&dir)).unwrap();
        let linked = worktrees.iter().find(|w| !w.is_main).unwrap();
        assert_eq!(linked.branch.as_deref(), Some("feature"));
        assert_eq!(linked.description.as_deref(), Some("詳細ペインの実装"));
    }

    #[test]
    fn worktree_reports_head_commit() {
        let (dir, _outside) = fixture_with_worktree();
        let worktrees = list_worktrees(&path_of(&dir)).unwrap();

        let main = worktrees.iter().find(|w| w.is_main).unwrap();
        assert_eq!(
            main.head_summary.as_deref(),
            Some("M"),
            "main の HEAD はマージコミット"
        );
        assert_eq!(main.head_time, Some(5_000));

        let linked = worktrees.iter().find(|w| !w.is_main).unwrap();
        assert_eq!(linked.head_summary.as_deref(), Some("C"));
        assert_eq!(linked.head_time, Some(3_000));
    }

    #[test]
    fn set_branch_description_writes_and_clears() {
        let dir = fixture();
        let path = path_of(&dir);

        let description_of = |name: &str| -> Option<String> {
            list_branches(&path, None)
                .unwrap()
                .into_iter()
                .find(|b| b.name == name)
                .and_then(|b| b.description)
        };

        set_branch_description(&path, "feature", Some("詳細ペインの作業用")).unwrap();
        assert_eq!(
            description_of("feature").as_deref(),
            Some("詳細ペインの作業用")
        );

        // 上書きできる
        set_branch_description(&path, "feature", Some("  前後の空白は落とす  ")).unwrap();
        assert_eq!(
            description_of("feature").as_deref(),
            Some("前後の空白は落とす")
        );

        // 空文字を渡すと消える
        set_branch_description(&path, "feature", Some("")).unwrap();
        assert_eq!(description_of("feature"), None);

        // 未設定のまま消しても成功扱い
        set_branch_description(&path, "feature", None).unwrap();
        assert_eq!(description_of("feature"), None);
    }

    #[test]
    fn set_branch_description_writes_to_local_config_only() {
        let dir = fixture();
        set_branch_description(&path_of(&dir), "main", Some("幹")).unwrap();

        // リポジトリ配下の .git/config にだけ書かれていること
        let config = std::fs::read_to_string(dir.path().join(".git/config")).unwrap();
        assert!(config.contains("description = 幹"), "{config}");
    }

    #[test]
    fn set_branch_description_rejects_unknown_branch() {
        let dir = fixture();
        let err = set_branch_description(&path_of(&dir), "no-such-branch", Some("x")).unwrap_err();
        assert!(err.contains("ローカルブランチが見つかりません"), "{err}");

        // リモート追跡ブランチにも設定できない
        let err = set_branch_description(&path_of(&dir), "origin/main", Some("x")).unwrap_err();
        assert!(err.contains("ローカルブランチが見つかりません"), "{err}");
    }
}
