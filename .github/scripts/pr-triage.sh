#!/usr/bin/env bash
set -euo pipefail

# Initialize a comma-separated string to hold PR numbers that need a comment
PRS_NEEDING_COMMENT=""

# Function to process a single PR
process_pr() {
    if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
        echo "‼️ Missing \$GITHUB_REPOSITORY - this must be run from GitHub Actions"
        return 1
    fi

    if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
        echo "‼️ Missing \$GITHUB_OUTPUT - this must be run from GitHub Actions"
        return 1
    fi

    local PR_NUMBER=$1
    echo "🔄 Processing PR #${PR_NUMBER}"

    # Get closing issue number with error handling
    local ISSUE_NUMBER
    if ! ISSUE_NUMBER=$(gh pr view "${PR_NUMBER}" --repo "${GITHUB_REPOSITORY}" --json closingIssuesReferences -q '.closingIssuesReferences.nodes[0].number' 2>/dev/null); then
        echo "   ⚠️ Could not fetch closing issue for PR #${PR_NUMBER}"
    fi

    if [[ -z "${ISSUE_NUMBER}" ]]; then
        echo "⚠️  No linked issue found for PR #${PR_NUMBER}, adding status/need-issue label"
        if ! gh pr edit "${PR_NUMBER}" --repo "${GITHUB_REPOSITORY}" --add-label "status/need-issue" 2>/dev/null; then
            echo "   ⚠️ Failed to add label (may already exist or have permission issues)"
        fi
        # Add PR number to the list
        if [[ -z "${PRS_NEEDING_COMMENT}" ]]; then
            PRS_NEEDING_COMMENT="${PR_NUMBER}"
        else
            PRS_NEEDING_COMMENT="${PRS_NEEDING_COMMENT},${PR_NUMBER}"
        fi
        echo "needs_comment=true" >> "${GITHUB_OUTPUT}"
    else
        echo "🔗 Found linked issue #${ISSUE_NUMBER}"

        # Remove status/need-issue label if present
        if ! gh pr edit "${PR_NUMBER}" --repo "${GITHUB_REPOSITORY}" --remove-label "status/need-issue" 2>/dev/null; then
            echo "   status/need-issue label not present or could not be removed"
        fi

        # Get issue labels
        echo "📥 Fetching labels from issue #${ISSUE_NUMBER}"
        local ISSUE_LABELS=""
        if ! ISSUE_LABELS=$(gh issue view "${ISSUE_NUMBER}" --repo "${GITHUB_REPOSITORY}" --json labels -q '.labels[].name' 2>/dev/null | tr '\n' ',' | sed 's/,$//' || echo ""); then
            echo "   ⚠️ Could not fetch issue #${ISSUE_NUMBER} (may not exist or be in different repo)"
            ISSUE_LABELS=""
        fi

        # Get PR labels
        echo "📥 Fetching labels from PR #${PR_NUMBER}"
        local PR_LABELS=""
        if ! PR_LABELS=$(gh pr view "${PR_NUMBER}" --repo "${GITHUB_REPOSITORY}" --json labels -q '.labels[].name' 2>/dev/null | tr '\n' ',' | sed 's/,$//' || echo ""); then
            echo "   ⚠️ Could not fetch PR labels"
            PR_LABELS=""
        fi

        echo "   Issue labels: ${ISSUE_LABELS}"
        echo "   PR labels: ${PR_LABELS}"

        # Convert comma-separated strings to arrays
        local ISSUE_LABEL_ARRAY PR_LABEL_ARRAY
        IFS=',' read -ra ISSUE_LABEL_ARRAY <<< "${ISSUE_LABELS}"
        IFS=',' read -ra PR_LABEL_ARRAY <<< "${PR_LABELS}"

        # Find labels to add (on issue but not on PR)
        local LABELS_TO_ADD=""
        for label in "${ISSUE_LABEL_ARRAY[@]}"; do
            if [[ -n "${label}" ]] && [[ " ${PR_LABEL_ARRAY[*]} " != *" ${label} "* ]]; then
                if [[ -z "${LABELS_TO_ADD}" ]]; then
                    LABELS_TO_ADD="${label}"
                else
                    LABELS_TO_ADD="${LABELS_TO_ADD},${label}"
                fi
            fi
        done

        # Apply label changes
        if [[ -n "${LABELS_TO_ADD}" ]]; then
            echo "➕ Adding labels: ${LABELS_TO_ADD}"
            if ! gh pr edit "${PR_NUMBER}" --repo "${GITHUB_REPOSITORY}" --add-label "${LABELS_TO_ADD}" 2>/dev/null; then
                echo "   ⚠️ Failed to add some labels"
            fi
        fi

        if [[ -z "${LABELS_TO_ADD}" ]]; then
            echo "✅ Labels already synchronized"
        fi
        echo "needs_comment=false" >> "${GITHUB_OUTPUT}"
    fi
}

# If PR_NUMBER is set, process only that PR
if [[ -n "${PR_NUMBER:-}" ]]; then
    if ! process_pr "${PR_NUMBER}"; then
        echo "❌ Failed to process PR #${PR_NUMBER}"
        exit 1
    fi
else
    # Otherwise, get all open PRs and process them
    # The script logic will determine which ones need issue linking or label sync
    echo "📥 Getting all open pull requests..."
    if ! PR_NUMBERS=$(gh pr list --repo "${GITHUB_REPOSITORY}" --state open --limit 1000 --json number -q '.[].number' 2>/dev/null); then
        echo "❌ Failed to fetch PR list"
        exit 1
    fi

    if [[ -z "${PR_NUMBERS}" ]]; then
        echo "✅ No open PRs found"
    else
        # Count the number of PRs
        PR_COUNT=$(echo "${PR_NUMBERS}" | wc -w | tr -d ' ')
        echo "📊 Found ${PR_COUNT} open PRs to process"

        for pr_number in ${PR_NUMBERS}; do
            if ! process_pr "${pr_number}"; then
                echo "⚠️ Failed to process PR #${pr_number}, continuing with next PR..."
                continue
            fi
        done
    fi
fi

# Ensure output is always set, even if empty
if [[ -z "${PRS_NEEDING_COMMENT}" ]]; then
    echo "prs_needing_comment=[]" >> "${GITHUB_OUTPUT}"
else
    echo "prs_needing_comment=[${PRS_NEEDING_COMMENT}]" >> "${GITHUB_OUTPUT}"
fi

echo "✅ PR triage completed"
