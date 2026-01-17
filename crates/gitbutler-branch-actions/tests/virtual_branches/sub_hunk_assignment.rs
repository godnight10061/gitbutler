use but_core::{DiffSpec, HunkHeader};
use but_hunk_assignment::HunkAssignmentRequest;
use gitbutler_testsupport::stack_details;

use super::*;

fn normalize_newlines(input: String) -> String {
    input.replace("\r\n", "\n")
}

fn read_file_at_ref(repo: &git2::Repository, refname: &str, path: &str) -> String {
    let obj = repo
        .revparse_single(refname)
        .unwrap_or_else(|_| panic!("ref {refname} exists"));
    let commit = obj
        .peel_to_commit()
        .unwrap_or_else(|_| panic!("ref {refname} points to a commit"));
    let tree = commit.tree().expect("commit has a tree");
    let entry = tree
        .get_path(std::path::Path::new(path))
        .unwrap_or_else(|_| panic!("tree at {refname} has {path}"));
    let blob = repo.find_blob(entry.id()).expect("entry is a blob");
    String::from_utf8(blob.content().to_vec()).expect("file content is utf8")
}

fn commit_all(repo: &git2::Repository, message: &str) -> git2::Oid {
    let mut index = repo.index().expect("repo has an index");
    index
        .add_all(["."], git2::IndexAddOption::DEFAULT, None)
        .expect("can add all paths");
    index.write().expect("can write index");

    let tree_id = index.write_tree().expect("can write tree");
    let tree = repo.find_tree(tree_id).expect("tree exists");
    let sig = git2::Signature::now("test", "test@email.com").expect("valid signature");
    let parent = repo
        .head()
        .expect("HEAD exists")
        .peel_to_commit()
        .expect("HEAD points to commit");
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
        .expect("commit succeeds")
}

#[test]
fn assign_individual_lines_to_different_stacks() -> anyhow::Result<()> {
    let Test { repo, ctx, .. } = &mut Test::default();

    // Create a baseline file and push it so `refs/remotes/origin/master` contains it.
    std::fs::write(
        repo.path().join("file.txt"),
        "base-1\nbase-2\nbase-3\n",
    )?;
    commit_all(&repo.local_repo, "add baseline file");
    repo.push();
    repo.fetch();

    gitbutler_branch_actions::set_base_branch(
        ctx,
        &"refs/remotes/origin/master".parse().unwrap(),
        ctx.exclusive_worktree_access().write_permission(),
    )?;

    gitbutler_branch_actions::create_virtual_branch(
        ctx,
        &BranchCreateRequest::default(),
        ctx.exclusive_worktree_access().write_permission(),
    )?;
    gitbutler_branch_actions::create_virtual_branch(
        ctx,
        &BranchCreateRequest::default(),
        ctx.exclusive_worktree_access().write_permission(),
    )?;
    let stacks = stack_details(ctx);
    assert_eq!(stacks.len(), 2, "expected two stacks in the workspace");
    let stack_a = stacks[0].0;
    let stack_b = stacks[1].0;

    // Produce a single diff hunk with two adjacent added lines.
    std::fs::write(
        repo.path().join("file.txt"),
        "base-1\nbase-2\nbase-3\nline-b\nline-a\n",
    )?;

    let changes = but_core::diff::ui::worktree_changes_by_worktree_dir(
        ctx.legacy_project.worktree_dir()?.to_owned(),
    )?
    .changes;
    let (assignments, _assignments_error) =
        but_hunk_assignment::assignments_with_fallback(ctx, false, Some(changes.clone()), None)?;

    let base_assignment = assignments
        .iter()
        .find(|a| a.path == "file.txt")
        .expect("file assignment exists");
    let added_lines = base_assignment
        .line_nums_added
        .as_deref()
        .expect("added line numbers are present");
    assert_eq!(added_lines.len(), 2, "expected two added lines in one hunk");

    // Assign the later line to stack A first, so unapplying it won't shift the earlier line.
    let hunk_b = HunkHeader {
        old_start: 0,
        old_lines: 0,
        new_start: added_lines[0] as u32,
        new_lines: 1,
    };
    let hunk_a = HunkHeader {
        old_start: 0,
        old_lines: 0,
        new_start: added_lines[1] as u32,
        new_lines: 1,
    };

    let req_a = HunkAssignmentRequest {
        hunk_header: Some(hunk_a),
        path_bytes: base_assignment.path_bytes.clone(),
        stack_id: Some(stack_a),
    };
    let req_b = HunkAssignmentRequest {
        hunk_header: Some(hunk_b),
        path_bytes: base_assignment.path_bytes.clone(),
        stack_id: Some(stack_b),
    };
    let _rejections = but_hunk_assignment::assign(ctx, vec![req_a, req_b], None)?;

    let (after, _assignments_error) =
        but_hunk_assignment::assignments_with_fallback(ctx, false, Some(changes.clone()), None)?;
    assert!(
        after.iter().any(|a| a.path == "file.txt" && a.hunk_header == Some(hunk_a) && a.stack_id == Some(stack_a)),
        "expected the later line to be assigned to stack A"
    );
    assert!(
        after.iter().any(|a| a.path == "file.txt" && a.hunk_header == Some(hunk_b) && a.stack_id == Some(stack_b)),
        "expected the earlier line to be assigned to stack B"
    );

    let stack_a_specs = but_workspace::flatten_diff_specs(
        after.iter()
            .filter(|a| a.stack_id == Some(stack_a))
            .cloned()
            .map(Into::into)
            .collect::<Vec<DiffSpec>>(),
    );
    let stack_a_ref = gitbutler_branch_actions::unapply_stack(ctx, stack_a, stack_a_specs)?;
    assert_eq!(
        normalize_newlines(read_file_at_ref(&repo.local_repo, &stack_a_ref, "file.txt")),
        "base-1\nbase-2\nbase-3\nline-a\n",
        "unapplying stack A should keep its assigned line on the branch"
    );
    assert_eq!(
        normalize_newlines(std::fs::read_to_string(repo.path().join("file.txt"))?),
        "base-1\nbase-2\nbase-3\nline-b\n",
        "unapplying stack A should only remove its line"
    );

    let changes = but_core::diff::ui::worktree_changes_by_worktree_dir(
        ctx.legacy_project.worktree_dir()?.to_owned(),
    )?
    .changes;
    let (after, _assignments_error) =
        but_hunk_assignment::assignments_with_fallback(ctx, false, Some(changes.clone()), None)?;
    let stack_b_specs = but_workspace::flatten_diff_specs(
        after.iter()
            .filter(|a| a.stack_id == Some(stack_b))
            .cloned()
            .map(Into::into)
            .collect::<Vec<DiffSpec>>(),
    );
    let stack_b_ref = gitbutler_branch_actions::unapply_stack(ctx, stack_b, stack_b_specs)?;
    assert_eq!(
        normalize_newlines(read_file_at_ref(&repo.local_repo, &stack_b_ref, "file.txt")),
        "base-1\nbase-2\nbase-3\nline-b\n",
        "unapplying stack B should keep its assigned line on the branch"
    );
    assert_eq!(
        normalize_newlines(std::fs::read_to_string(repo.path().join("file.txt"))?),
        "base-1\nbase-2\nbase-3\n",
        "unapplying stack B should remove its line as well"
    );

    Ok(())
}
