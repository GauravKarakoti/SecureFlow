# Prompt Injection in AI Explanation Generation

## Context

`developerReceivesAISecurityExplanations()` (in
`src/ai/flows/developer-receives-ai-security-explanations.ts`) sends the raw `codeSnippet` from a
scanned PR diff to an LLM to generate a human-readable `explanation` and `remediationSuggestions`
for each finding. Because PR authors fully control the diff content, this is a prompt-injection
surface: the untrusted data source and the potential attacker are the same actor.

## Security boundary: the policy gate is unaffected

**The PASS / REVIEW REQUIRED / BLOCKED decision made by `ArmorIQPolicyEngine.evaluateFindings()`
in `src/lib/armor/iq.ts` only ever consumes `finding.severity`, which comes from the trusted
static scanner (`src/lib/armor/scanner.ts`).** It never reads the AI-generated `explanation` or
`remediationSuggestions`. This was true before this change and remains true after it — nothing in
this document changes the policy engine.

What prompt injection *can* affect, prior to this change, is the narrative text a developer reads
next to a correctly-labeled finding — for example, a `🔴 CRITICAL` badge sitting next to an AI
explanation that's been nudged to sound reassuring or dismissive. That undermines trust in the
tool even though the automated gate is safe.

## Defense in depth

Four independent layers now protect the explanation layer:

1. **Structural isolation** (`buildPrompt` in the flow file): the `codeSnippet` is wrapped in
   explicit `=== BEGIN/END UNTRUSTED INTERCEPTED PAYLOAD ===` delimiters, and both the system and
   user messages state that content inside those delimiters is data to analyze, never instructions
   to follow — regardless of what it claims to be (a system message, a new persona, a command to
   ignore prior instructions, etc).
2. **Injection-pattern pre-filter** (`detectPromptInjection`): scans `codeSnippet` and
   `description` for common injection markers (fake role turns, "ignore previous instructions",
   directives to mark a finding as safe, etc.) before the prompt is sent. This is **advisory**,
   not a hard block — a match sets `promptInjectionSuspected: true` on the finding so reviewers
   know to trust the static severity badge over the AI narrative, but the explanation is still
   shown. Over-flagging (e.g. a legitimate comment that discusses prompt injection) is preferred
   over silently suppressing the explanation.
3. **Output consistency check** (`contradictsSeverity`): after the model responds, a CRITICAL or
   HIGH finding whose explanation contains dismissive language ("not a real issue", "safe to
   ignore", "false positive", etc.) is also flagged, catching cases where a novel injection
   technique got past the pre-filter but still visibly swayed the output.
4. **UI surfacing**: when `promptInjectionSuspected` is true, both the PR comment and the
   dashboard findings view show a `⚠️ AI explanation may be unreliable for this finding — verify
   manually` note next to that specific finding.

## Testing

`src/ai/flows/__tests__/developer-receives-ai-security-explanations.test.ts` exercises the
pre-filter and consistency check directly, plus the full
`developerReceivesAISecurityExplanations()` flow end-to-end against a mocked LLM (no network
calls), covering: known injection-style payloads, benign code with no injection framing, a
model that resists injection, and a model that gets fooled and produces a dismissive explanation
for a CRITICAL finding.

Run with:

```bash
npm test
```
