// SPDX-License-Identifier: Apache-2.0

// Package bridge shows how a self-hosted orchestrator can expose its business
// operations to a Qoder Cloud Agent as client-side custom tools, while keeping
// the allowlist, validation, and task scope enforced in its own process.
//
// This dispatcher is a self-contained, standalone illustration of the pattern
// described in the accompanying Cookbook article. It has no third-party
// dependencies and does not reference any private system.
package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// TaskKind is the surface a run is bound to. An issue task may touch only its
// assigned issue; a chat task may list the workspace.
type TaskKind int

const (
	TaskChat TaskKind = iota
	TaskIssue
)

// TaskScope binds a run to a single user, workspace, and (for issue tasks) one
// assigned issue. The dispatcher enforces it on every call.
type TaskScope struct {
	Kind            TaskKind
	AssignedIssueID string // required when Kind == TaskIssue
}

// IssueStore is the narrow business API the dispatcher is allowed to reach.
// A real implementation would call an authenticated backend; the demo uses an
// in-memory fake in tests.
type IssueStore interface {
	ListIssues(status string, limit int) (string, error)
	GetIssue(id string) (string, error)
	UpdateIssue(id string, fields map[string]string) (string, error)
	AddComment(issueID, content, parentID string) (string, error)
}

var (
	uuidPattern     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	allowedStatus   = map[string]bool{"backlog": true, "todo": true, "in_progress": true, "in_review": true, "done": true, "blocked": true, "cancelled": true}
	allowedPriority = map[string]bool{"urgent": true, "high": true, "medium": true, "low": true, "none": true}
)

const (
	maxTitleLen   = 500
	maxContentLen = 20000
	maxListLimit  = 50
)

// ErrUnknownTool is returned for any name outside the fixed allowlist.
var ErrUnknownTool = errors.New("unknown tool")

// Dispatch validates one custom-tool request against the allowlist and task
// scope, then performs the single allowed operation. rawInput is the tool
// input exactly as the cloud Agent sent it. It fails closed: unknown tools,
// unknown JSON fields, invalid values, and out-of-scope targets all error
// before any store call.
func Dispatch(store IssueStore, scope TaskScope, tool string, rawInput []byte) (string, error) {
	switch tool {
	case "multica_list_issues":
		var in struct {
			Status string `json:"status"`
			Limit  int    `json:"limit"`
		}
		if err := strictUnmarshal(rawInput, &in); err != nil {
			return "", err
		}
		if in.Status != "" && !allowedStatus[in.Status] {
			return "", fmt.Errorf("invalid status: %q", in.Status)
		}
		if in.Limit != 0 && (in.Limit < 1 || in.Limit > maxListLimit) {
			return "", fmt.Errorf("limit must be 1..%d", maxListLimit)
		}
		// An issue task is scoped to exactly its assigned issue.
		if scope.Kind == TaskIssue {
			return store.GetIssue(scope.AssignedIssueID)
		}
		return store.ListIssues(in.Status, in.Limit)

	case "multica_get_issue":
		var in struct {
			IssueID string `json:"issue_id"`
		}
		if err := strictUnmarshal(rawInput, &in); err != nil {
			return "", err
		}
		if !uuidPattern.MatchString(in.IssueID) {
			return "", errors.New("issue_id must be a UUID")
		}
		if err := requireScope(scope, in.IssueID); err != nil {
			return "", err
		}
		return store.GetIssue(in.IssueID)

	case "multica_update_issue":
		var in struct {
			IssueID     string `json:"issue_id"`
			Title       string `json:"title"`
			Description string `json:"description"`
			Status      string `json:"status"`
			Priority    string `json:"priority"`
		}
		if err := strictUnmarshal(rawInput, &in); err != nil {
			return "", err
		}
		if !uuidPattern.MatchString(in.IssueID) {
			return "", errors.New("issue_id must be a UUID")
		}
		if err := requireScope(scope, in.IssueID); err != nil {
			return "", err
		}
		fields := map[string]string{}
		if in.Title != "" {
			if len(in.Title) > maxTitleLen {
				return "", fmt.Errorf("title must be 1..%d chars", maxTitleLen)
			}
			fields["title"] = in.Title
		}
		if in.Description != "" {
			if len(in.Description) > maxContentLen {
				return "", fmt.Errorf("description must be <=%d chars", maxContentLen)
			}
			fields["description"] = in.Description
		}
		if in.Status != "" {
			if !allowedStatus[in.Status] {
				return "", fmt.Errorf("invalid status: %q", in.Status)
			}
			fields["status"] = in.Status
		}
		if in.Priority != "" {
			if !allowedPriority[in.Priority] {
				return "", fmt.Errorf("invalid priority: %q", in.Priority)
			}
			fields["priority"] = in.Priority
		}
		if len(fields) == 0 {
			return "", errors.New("update requires at least one field")
		}
		return store.UpdateIssue(in.IssueID, fields)

	case "multica_add_issue_comment":
		var in struct {
			IssueID  string `json:"issue_id"`
			Content  string `json:"content"`
			ParentID string `json:"parent_id"`
		}
		if err := strictUnmarshal(rawInput, &in); err != nil {
			return "", err
		}
		if !uuidPattern.MatchString(in.IssueID) {
			return "", errors.New("issue_id must be a UUID")
		}
		if err := requireScope(scope, in.IssueID); err != nil {
			return "", err
		}
		if in.Content == "" || len(in.Content) > maxContentLen {
			return "", fmt.Errorf("content must be 1..%d chars", maxContentLen)
		}
		if in.ParentID != "" && !uuidPattern.MatchString(in.ParentID) {
			return "", errors.New("parent_id must be a UUID")
		}
		return store.AddComment(in.IssueID, in.Content, in.ParentID)

	default:
		return "", fmt.Errorf("%w: %q", ErrUnknownTool, tool)
	}
}

// requireScope rejects any issue target other than the task's assigned issue.
func requireScope(scope TaskScope, issueID string) error {
	if scope.Kind == TaskIssue && issueID != scope.AssignedIssueID {
		return fmt.Errorf("issue task may not target another issue")
	}
	return nil
}

// strictUnmarshal rejects unknown JSON fields so a cloud-supplied payload
// cannot smuggle extra keys past validation.
func strictUnmarshal(raw []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return fmt.Errorf("invalid tool input: %w", err)
	}
	return nil
}
