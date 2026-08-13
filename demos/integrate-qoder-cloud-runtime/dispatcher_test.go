// SPDX-License-Identifier: Apache-2.0

package bridge

import (
	"errors"
	"testing"
)

// fakeStore records calls so tests can assert exactly-once execution.
type fakeStore struct {
	updates  int
	comments int
}

func (f *fakeStore) ListIssues(status string, limit int) (string, error) {
	return `[{"id":"issue-1"}]`, nil
}
func (f *fakeStore) GetIssue(id string) (string, error) {
	return `{"id":"` + id + `"}`, nil
}
func (f *fakeStore) UpdateIssue(id string, fields map[string]string) (string, error) {
	f.updates++
	return `{"id":"` + id + `","updated":true}`, nil
}
func (f *fakeStore) AddComment(issueID, content, parentID string) (string, error) {
	f.comments++
	return `{"id":"comment-1"}`, nil
}

const assignedID = "11111111-1111-4111-8111-111111111111"

func TestDispatchRejectsInvalidInput(t *testing.T) {
	store := &fakeStore{}
	scope := TaskScope{Kind: TaskChat}
	cases := []struct {
		name  string
		tool  string
		input string
	}{
		{"unknown tool", "multica_delete_everything", `{}`},
		{"unknown field", "multica_get_issue", `{"issue_id":"` + assignedID + `","extra":1}`},
		{"non-uuid", "multica_get_issue", `{"issue_id":"not-a-uuid"}`},
		{"invalid enum", "multica_update_issue", `{"issue_id":"` + assignedID + `","status":"shipped"}`},
		{"empty update", "multica_update_issue", `{"issue_id":"` + assignedID + `"}`},
		{"fractional limit", "multica_list_issues", `{"limit":1.5}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Dispatch(store, scope, tc.tool, []byte(tc.input)); err == nil {
				t.Fatalf("expected error for %s", tc.name)
			}
		})
	}
	if store.updates != 0 || store.comments != 0 {
		t.Fatalf("invalid inputs must not reach the store: updates=%d comments=%d", store.updates, store.comments)
	}
}

func TestDispatchEnforcesIssueScope(t *testing.T) {
	store := &fakeStore{}
	scope := TaskScope{Kind: TaskIssue, AssignedIssueID: assignedID}
	other := "22222222-2222-4222-8222-222222222222"
	if _, err := Dispatch(store, scope, "multica_get_issue", []byte(`{"issue_id":"`+other+`"}`)); err == nil {
		t.Fatal("issue task must not read another issue")
	}
	if out, err := Dispatch(store, scope, "multica_get_issue", []byte(`{"issue_id":"`+assignedID+`"}`)); err != nil {
		t.Fatalf("assigned issue read failed: %v", err)
	} else if out == "" {
		t.Fatal("expected issue payload")
	}
}

func TestDispatchUnknownToolIsTyped(t *testing.T) {
	_, err := Dispatch(&fakeStore{}, TaskScope{Kind: TaskChat}, "nope", []byte(`{}`))
	if !errors.Is(err, ErrUnknownTool) {
		t.Fatalf("expected ErrUnknownTool, got %v", err)
	}
}
