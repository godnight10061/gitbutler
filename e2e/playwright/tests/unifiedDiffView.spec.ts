import { getHunkLineSelector } from '../src/hunk.ts';
import { getBaseURL, startGitButler, type GitButler } from '../src/setup.ts';
import { clickByTestId, fillByTestId, getByTestId, waitForTestId } from '../src/util.ts';
import { expect, Locator, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

let gitbutler: GitButler;

test.use({
	baseURL: getBaseURL()
});

test.afterEach(async () => {
	await gitbutler?.destroy();
});

const BIG_FILE_PATH_BEFORE = resolve(import.meta.dirname, '../fixtures/big-file_before.md');
const BIG_FILE_PATH_AFTER = resolve(import.meta.dirname, '../fixtures/big-file_after.md');

test('should be able to select the hunks correctly in a complex file', async ({
	page,
	context
}, testInfo) => {
	const workdir = testInfo.outputPath('workdir');
	const configdir = testInfo.outputPath('config');
	gitbutler = await startGitButler(workdir, configdir, context);

	const projectName = 'my-new-project';
	const fileName = 'big-file.md';

	const projectPath = gitbutler.pathInWorkdir(projectName + '/');
	const bigFilePath = join(projectPath, fileName);
	const contentBefore = readFileSync(BIG_FILE_PATH_BEFORE, 'utf-8');
	const contentAfter = readFileSync(BIG_FILE_PATH_AFTER, 'utf-8');

	await gitbutler.runScript('project-with-remote-branches.sh');
	// Add the big file on the remote base
	await gitbutler.runScript('project-with-remote-branches__commit-file-into-remote-base.sh', [
		'Create big file with complex changes',
		fileName,
		contentBefore
	]);
	// Clone into a new project
	await gitbutler.runScript('project-with-remote-branches__clone-into-new-project.sh', [
		projectName
	]);
	// Delete the other project to avoid having to switch between them
	await gitbutler.runScript('project-with-remote-branches__delete-project.sh', ['local-clone']);

	await page.goto('/');

	// Should load the workspace
	await waitForTestId(page, 'workspace-view');

	// Make the changes to the big file in the local project
	writeFileSync(bigFilePath, contentAfter, 'utf-8');

	// Start the commit process
	await clickByTestId(page, 'commit-to-new-branch-button');

	// The file should appear on the uncommitted changes area
	const uncommittedChangesList = getByTestId(page, 'uncommitted-changes-file-list');
	let fileItem = uncommittedChangesList.getByTestId('file-list-item').filter({ hasText: fileName });
	await expect(fileItem).toBeVisible();
	await fileItem.click();

	// The unified diff view should be visible
	const unifiedDiffView = getByTestId(page, 'unified-diff-view');
	await expect(unifiedDiffView).toBeVisible();

	let leftLines = [1, 5, 9, 11, 13, 19, 23];
	let rightLines = [1, 5, 9, 11, 13, 19, 23];

	// Unselect a couple of lines
	await unselectHunkLines(fileName, unifiedDiffView, leftLines, rightLines);

	// Commit the changes
	await fillByTestId(page, 'commit-drawer-title-input', 'Partial commit: Part 1');
	await clickByTestId(page, 'commit-drawer-action-button');

	// Start the commit process
	await clickByTestId(page, 'start-commit-button');

	fileItem = uncommittedChangesList.getByTestId('file-list-item').filter({ hasText: fileName });
	await expect(fileItem).toBeVisible();
	await fileItem.click();

	leftLines = [1, 5, 9, 11];
	rightLines = [1, 5, 9, 11];

	// Unselect a couple of lines
	await unselectHunkLines(fileName, unifiedDiffView, leftLines, rightLines);

	// Commit the changes
	await fillByTestId(page, 'commit-drawer-title-input', 'Partial commit: Part 2');
	await clickByTestId(page, 'commit-drawer-action-button');

	// Start the commit process
	await clickByTestId(page, 'start-commit-button');

	// Commit the changes
	await fillByTestId(page, 'commit-drawer-title-input', 'Full commit: Part 3');
	await clickByTestId(page, 'commit-drawer-action-button');

	// Verify the commits
	const commits = getByTestId(page, 'commit-row');
	await expect(commits).toHaveCount(3);
});

test('should discard an untracked added file via context menu', async ({
	page,
	context
}, testInfo) => {
	const workdir = testInfo.outputPath('workdir');
	const configdir = testInfo.outputPath('config');
	gitbutler = await startGitButler(workdir, configdir, context);

	const fileName = 'demo.txt';
	const projectPath = gitbutler.pathInWorkdir('local-clone/');
	const filePath = join(projectPath, fileName);

	await gitbutler.runScript('project-with-remote-branches.sh');

	await page.goto('/');

	// Should load the workspace
	await waitForTestId(page, 'workspace-view');

	// Create an untracked file.
	writeFileSync(filePath, 'Hello world\nSecond line\n', 'utf-8');
	expect(existsSync(filePath)).toBe(true);

	// The file should appear on the uncommitted changes area
	const uncommittedChangesList = getByTestId(page, 'uncommitted-changes-file-list');
	const fileItem = uncommittedChangesList
		.getByTestId('file-list-item')
		.filter({ hasText: fileName });
	await expect(fileItem).toBeVisible();
	await fileItem.click();

	// The unified diff view should be visible
	const unifiedDiffView = getByTestId(page, 'unified-diff-view');
	await expect(unifiedDiffView).toBeVisible();

	// Open the hunk context menu for the added file and discard it.
	await unifiedDiffView
		.locator('[data-testid="hunk-count-column"]')
		.first()
		.click({ button: 'right' });
	await waitForTestId(page, 'hunk-context-menu');
	await clickByTestId(page, 'hunk-context-menu-discard-change');

	await expect.poll(() => existsSync(filePath)).toBe(false);
	await expect(fileItem).toHaveCount(0);
	await expect(getByTestId(page, 'workspace-view')).toBeVisible();
});

test('should uncommit an added file when dragging a committed hunk', async ({
	page,
	context
}, testInfo) => {
	testInfo.setTimeout(120_000);

	const workdir = testInfo.outputPath('workdir');
	const configdir = testInfo.outputPath('config');
	gitbutler = await startGitButler(workdir, configdir, context);

	const fileName = 'dummy.txt';
	const keepFileName = 'a_file';
	const projectPath = gitbutler.pathInWorkdir('local-clone/');
	const filePath = join(projectPath, fileName);
	const keepFilePath = join(projectPath, keepFileName);

	await gitbutler.runScript('project-with-remote-branches.sh');
	await gitbutler.runScript('apply-upstream-branch.sh', ['branch1', 'local-clone']);

	await page.goto('/');

	// Should load the workspace.
	await waitForTestId(page, 'workspace-view');

	// Create a new file and a small modification so the commit stays non-empty after uncommitting the file.
	writeFileSync(filePath, 'dummy line 1\ndummy line 2\n', 'utf-8');
	appendFileSync(keepFilePath, 'keep-in-commit\n', 'utf-8');

	// Ensure the UI picks up the new untracked file on Windows.
	await page.reload();
	await waitForTestId(page, 'workspace-view');

	const uncommittedChangesList = getByTestId(page, 'uncommitted-changes-file-list');
	const uncommittedFileItem = uncommittedChangesList
		.getByTestId('file-list-item')
		.filter({ hasText: fileName })
		.first();
	await expect(uncommittedFileItem).toBeVisible({ timeout: 15_000 });

	// Commit the changes so we can uncommit them via the committed diff view.
	const commitTitle = 'Uncommit added file: source';
	await clickByTestId(page, 'start-commit-button');
	await fillByTestId(page, 'commit-drawer-title-input', commitTitle);
	await clickByTestId(page, 'commit-drawer-action-button');

	const commitRow = getByTestId(page, 'commit-row').filter({ hasText: commitTitle });
	await expect(commitRow).toBeVisible();

	// Open the commit details panel and select the newly added file.
	await commitRow.click();
	const stack = getByTestId(page, 'stack');
	const committedFileItem = stack
		.getByTestId('file-list-item')
		.filter({ hasText: fileName })
		.first();
	await expect(committedFileItem).toBeVisible({ timeout: 30_000 });
	await committedFileItem.click();

	const stackPreview = getByTestId(page, 'stack-preview');
	await expect(stackPreview).toBeVisible({ timeout: 15_000 });
	const unifiedDiffView = stackPreview.getByTestId('unified-diff-view').first();
	await expect(unifiedDiffView).toBeVisible();

	// Select a delta line to ensure we attempt a hunk-based uncommit.
	const lineSelector = getHunkLineSelector(fileName, 1, 'right');
	const line = stackPreview.locator(lineSelector).first();
	await expect(line).toBeVisible({ timeout: 15_000 });
	await line.click();

	const originalCommitId = await commitRow.getAttribute('data-commit-id');
	expect(originalCommitId).toBeTruthy();

	// Drag the committed hunk onto the Unassigned worktree lane to uncommit it.
	const hunkTitle = line
		.locator('xpath=ancestor::table[1]')
		.locator('.table__title-content')
		.first();
	const unassignedLaneHeader = getByTestId(page, 'uncommitted-changes-header')
		.filter({ hasText: /Unstaged|Unassigned/i })
		.first();

	await hunkTitle.hover();
	await page.mouse.down();
	await unassignedLaneHeader.hover({ force: true });
	await page.mouse.up();

	// Wait for the commit to be rewritten and verify the added file was uncommitted.
	await expect
		.poll(async () => (await commitRow.getAttribute('data-commit-id')) ?? '', {
			timeout: 15_000
		})
		.not.toBe(originalCommitId);

	const finalCommitId = (await commitRow.getAttribute('data-commit-id'))!;

	function gitShowNames(commitId: string) {
		return execFileSync('git', ['show', '--name-only', '--pretty=format:', commitId], {
			cwd: projectPath,
			encoding: 'utf-8'
		});
	}

	function gitStatusPorcelain() {
		return execFileSync('git', ['status', '--porcelain'], { cwd: projectPath, encoding: 'utf-8' });
	}

	await expect.poll(() => gitShowNames(finalCommitId)).toContain(keepFileName);
	await expect.poll(() => gitShowNames(finalCommitId)).not.toContain(fileName);
	await expect.poll(gitStatusPorcelain).toContain(`?? ${fileName}`);

	await expect(uncommittedFileItem).toBeVisible({ timeout: 15_000 });
});

test('should uncommit only the selected lines when dragging a committed hunk', async ({
	page,
	context
}, testInfo) => {
	testInfo.setTimeout(120_000);

	const workdir = testInfo.outputPath('workdir');
	const configdir = testInfo.outputPath('config');
	gitbutler = await startGitButler(workdir, configdir, context);

	const fileName = 'a_file';
	const projectPath = gitbutler.pathInWorkdir('local-clone/');
	const filePath = join(projectPath, fileName);

	await gitbutler.runScript('project-with-remote-branches.sh');
	await gitbutler.runScript('apply-upstream-branch.sh', ['branch1', 'local-clone']);

	await page.goto('/');

	// Should load the workspace.
	await waitForTestId(page, 'workspace-view');

	// Create a new commit containing a multi-line hunk at the end of the file.
	const addedLines = [
		'partial-uncommit-line-1',
		'partial-uncommit-line-2',
		'partial-uncommit-line-3'
	];
	appendFileSync(filePath, `${addedLines.join('\n')}\n`, 'utf-8');

	const fullFileLines = readFileSync(filePath, 'utf-8').split('\n');
	if (fullFileLines.at(-1) === '') fullFileLines.pop();
	const totalLineCount = fullFileLines.length;
	const selectedLineNumbers = [totalLineCount - 2, totalLineCount - 1];

	const uncommittedChangesList = getByTestId(page, 'uncommitted-changes-file-list');
	await expect(
		uncommittedChangesList.getByTestId('file-list-item').filter({ hasText: fileName }).first()
	).toBeVisible({ timeout: 15_000 });

	// Commit all changes so the hunk becomes committed.
	const sourceCommitTitle = 'Partial uncommit: source';
	await clickByTestId(page, 'start-commit-button');
	await fillByTestId(page, 'commit-drawer-title-input', sourceCommitTitle);
	await clickByTestId(page, 'commit-drawer-action-button');

	const sourceCommitRow = getByTestId(page, 'commit-row').filter({ hasText: sourceCommitTitle });
	await expect(sourceCommitRow).toBeVisible();

	// Open the commit details panel and select the file to see the committed diff.
	await sourceCommitRow.click();
	const stack = getByTestId(page, 'stack');
	const committedFileItem = stack
		.getByTestId('file-list-item')
		.filter({ hasText: fileName })
		.first();
	await expect(committedFileItem).toBeVisible({ timeout: 30_000 });
	await committedFileItem.click();

	const stackPreview = getByTestId(page, 'stack-preview');
	await expect(stackPreview).toBeVisible({ timeout: 15_000 });
	const unifiedDiffView = stackPreview.getByTestId('unified-diff-view').first();
	await expect(unifiedDiffView).toBeVisible();

	// Select only two delta lines in the committed hunk.
	let lineForDrag: Locator | undefined;
	for (const lineNumber of selectedLineNumbers) {
		const selector = getHunkLineSelector(fileName, lineNumber, 'right');
		const line = unifiedDiffView.locator(selector).first();
		await expect(line).toBeVisible();
		await line.click();
		lineForDrag ??= line;
	}

	const originalSourceCommitId = await sourceCommitRow.getAttribute('data-commit-id');
	expect(originalSourceCommitId).toBeTruthy();

	// Drag the committed hunk back to the Unassigned worktree lane.
	if (!lineForDrag) throw new Error('No selectable line found');

	const hunkTitle = lineForDrag
		.locator('xpath=ancestor::table[1]')
		.locator('.table__title-content')
		.first();
	const unassignedLaneHeader = getByTestId(page, 'uncommitted-changes-header')
		.filter({ hasText: /Unstaged|Unassigned/i })
		.first();

	await hunkTitle.hover();
	await page.mouse.down();
	await unassignedLaneHeader.hover({ force: true });
	await page.mouse.up();

	// Wait for the commit to be rewritten.
	await expect
		.poll(async () => (await sourceCommitRow.getAttribute('data-commit-id')) ?? '', {
			timeout: 15_000
		})
		.not.toBe(originalSourceCommitId);

	const finalSourceCommitId = (await sourceCommitRow.getAttribute('data-commit-id'))!;

	function gitShow(commitId: string) {
		return execFileSync('git', ['show', '--pretty=format:', commitId], {
			cwd: projectPath,
			encoding: 'utf-8'
		});
	}

	// Only the selected lines should be uncommitted, leaving the last line behind in the commit.
	const remainingLine = addedLines[2]!;
	await expect.poll(() => gitShow(finalSourceCommitId)).toContain(remainingLine);

	for (const selectedLine of addedLines.slice(0, 2)) {
		await expect.poll(() => gitShow(finalSourceCommitId)).not.toContain(selectedLine);
	}
});

async function unselectHunkLines(
	fileName: string,
	unifiedDiffView: Locator,
	leftLines: number[],
	rightLines: number[]
) {
	for (const line of leftLines) {
		const leftSelector = getHunkLineSelector(fileName, line, 'left');
		const leftLine = unifiedDiffView.locator(leftSelector).first();
		await expect(leftLine).toBeVisible();
		await leftLine.click();
	}

	for (const line of rightLines) {
		const rightSelector = getHunkLineSelector(fileName, line, 'right');
		const rightLine = unifiedDiffView.locator(rightSelector).first();
		await expect(rightLine).toBeVisible();
		await rightLine.click();
	}
}
