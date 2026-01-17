use std::cmp::Ordering;

use bstr::ByteSlice;
use but_core::ref_metadata::StackId;
use but_core::HunkHeader;
use itertools::Itertools;
use uuid::Uuid;

use crate::HunkAssignment;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MultipleOverlapping {
    SetNone,
    SetMostLines,
}

impl HunkAssignment {
    fn set_from(&mut self, other: &Self, applied_stack_ids: &[StackId], update_unassigned: bool) {
        // Always override the locks with the from the other assignment
        self.hunk_locks = other.hunk_locks.clone();
        // Always set the path from the other assignment
        self.path = other.path.clone();
        // Override the id only if the other assignment has an id
        if other.id.is_some() {
            self.id = other.id;
        }
        // Override the lines added only if the other assignment has them set
        if other.line_nums_added.is_some() {
            self.line_nums_added = other.line_nums_added.clone();
        }
        // Override the lines removed only if the other assignment has them set
        if other.line_nums_removed.is_some() {
            self.line_nums_removed = other.line_nums_removed.clone();
        }

        // Override the stack_id only if the current assignment has a stack_id or if update_unassigned is true
        match self.stack_id {
            Some(_) => {
                self.stack_id = other.stack_id;
            }
            None => {
                if update_unassigned {
                    self.stack_id = other.stack_id;
                }
            }
        }
        // If the self.stack_id is set, ensure that it is a value that is still in the applied_stack_ids. If not, reset it to None.
        if let Some(stack_id) = self.stack_id
            && !applied_stack_ids.contains(&stack_id)
        {
            self.stack_id = None;
        }
    }
}

fn is_selector_hunk(header: HunkHeader) -> bool {
    header.old_range().is_null() || header.new_range().is_null()
}

fn specificity(header: HunkHeader) -> u32 {
    if header.old_range().is_null() {
        header.new_lines
    } else if header.new_range().is_null() {
        header.old_lines
    } else {
        header.old_lines.max(header.new_lines)
    }
}

fn split_into_line_selections(base: &HunkAssignment) -> Vec<HunkAssignment> {
    let (Some(hunk_header), Some(diff)) = (base.hunk_header, base.diff.as_ref()) else {
        return vec![base.clone()];
    };

    let mut old_line_num = hunk_header.old_start as usize;
    let mut new_line_num = hunk_header.new_start as usize;
    let mut out = Vec::new();

    let mut base_id = base.id;
    for line in diff.lines() {
        let Some(first_char) = line.first() else {
            continue;
        };
        match *first_char {
            b'+' => {
                let id = base_id.take().or_else(|| Some(Uuid::new_v4()));
                out.push(HunkAssignment {
                    id,
                    hunk_header: Some(HunkHeader {
                        old_start: 0,
                        old_lines: 0,
                        new_start: new_line_num as u32,
                        new_lines: 1,
                    }),
                    path: base.path.clone(),
                    path_bytes: base.path_bytes.clone(),
                    stack_id: base.stack_id,
                    hunk_locks: base.hunk_locks.clone(),
                    line_nums_added: Some(vec![new_line_num]),
                    line_nums_removed: Some(Vec::new()),
                    diff: None,
                });
                new_line_num += 1;
            }
            b'-' => {
                let id = base_id.take().or_else(|| Some(Uuid::new_v4()));
                out.push(HunkAssignment {
                    id,
                    hunk_header: Some(HunkHeader {
                        old_start: old_line_num as u32,
                        old_lines: 1,
                        new_start: 0,
                        new_lines: 0,
                    }),
                    path: base.path.clone(),
                    path_bytes: base.path_bytes.clone(),
                    stack_id: base.stack_id,
                    hunk_locks: base.hunk_locks.clone(),
                    line_nums_added: Some(Vec::new()),
                    line_nums_removed: Some(vec![old_line_num]),
                    diff: None,
                });
                old_line_num += 1;
            }
            b' ' => {
                old_line_num += 1;
                new_line_num += 1;
            }
            b'@' | b'\\' => {
                // Header line or `\ No newline at end of file`.
            }
            _ => {
                // Treat all other lines as context.
                old_line_num += 1;
                new_line_num += 1;
            }
        }
    }

    if out.is_empty() {
        vec![base.clone()]
    } else {
        out
    }
}

pub(crate) fn assignments(
    new: &[HunkAssignment],
    old: &[HunkAssignment],
    applied_stack_ids: &[StackId],
    multiple_overlapping_resolution: MultipleOverlapping,
    update_unassigned: bool,
) -> Vec<HunkAssignment> {
    let mut reconciled = vec![];
    for new_assignment in new {
        let mut new_assignment = new_assignment.clone();
        let intersecting = old
            .iter()
            .filter(|current_entry| current_entry.intersects(new_assignment.clone()))
            .collect::<Vec<_>>();

        let has_selector_intersection = new_assignment.diff.is_some()
            && intersecting.iter().any(|a| {
                a.hunk_header
                    .is_some_and(|header| is_selector_hunk(header))
            });
        if has_selector_intersection {
            let mut pieces = split_into_line_selections(&new_assignment);
            for piece in pieces.iter_mut() {
                let mut old_for_piece = intersecting
                    .iter()
                    .copied()
                    .filter(|a| a.intersects(piece.clone()))
                    .collect::<Vec<_>>();
                old_for_piece.sort_by_key(|a| {
                    // Apply broad assignments first, then more specific ones.
                    a.hunk_header.map(specificity).unwrap_or(u32::MAX)
                });
                for old in old_for_piece.into_iter().rev() {
                    piece.set_from(old, applied_stack_ids, update_unassigned);
                }
                if let Some(stack_id) = piece.stack_id
                    && !applied_stack_ids.contains(&stack_id)
                {
                    piece.stack_id = None;
                }
            }
            reconciled.extend(pieces);
            continue;
        }

        match intersecting.len().cmp(&1) {
            Ordering::Less => {
                // No intersection - do nothing, the None assignment is kept
                let matching_file = old
                    .iter()
                    .filter(|current_entry| current_entry.path == new_assignment.path)
                    .collect::<Vec<_>>();
                if let Some(matching_file) = matching_file.first() {
                    new_assignment.hunk_locks = matching_file.hunk_locks.clone();
                }
            }
            Ordering::Equal => {
                new_assignment.set_from(intersecting[0], applied_stack_ids, update_unassigned);
            }
            Ordering::Greater => {
                // Pick the hunk with the most lines to adopt the assignment info from.
                let biggest_hunk = intersecting
                    .iter()
                    .max_by_key(|h| h.hunk_header.as_ref().map(|h| h.new_lines));
                if let Some(other) = biggest_hunk {
                    new_assignment.set_from(other, applied_stack_ids, update_unassigned);
                }

                // If requested, reset stack_id to none on multiple overlapping
                let unique_stack_ids = intersecting.iter().filter_map(|a| a.stack_id).unique();
                if multiple_overlapping_resolution == MultipleOverlapping::SetNone
                    && unique_stack_ids.count() > 1
                {
                    new_assignment.stack_id = None;
                }
            }
        }
        reconciled.push(new_assignment);
    }
    reconciled
}
