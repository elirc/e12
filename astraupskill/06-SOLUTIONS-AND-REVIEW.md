# Solution guidance and review habits

Use this chapter after making your own attempt. These are design directions, not claims that the practice features already exist. A good solution preserves existing behavior unless its acceptance criteria explicitly change it. Compare your work with [the practice assignments](05-PRACTICE.md) and cite the tests that demonstrate each claim.

## The rule you would extend

Validation feedback lives in one exported function, so a better message is a change in one place rather than in each route. From `src/server/contracts.js:186-194`:

```js
export function validateStrategySettings(value, field = "strategy") {
  strategyType(value.type, `${field}.type`);
  const params = parameters(value.parameters ?? {}, `${field}.parameters`);
  if (value.type === "gradual_rollout") {
    if (!Object.hasOwn(params, "rollout"))
      reject(field, "gradual rollout requires a rollout percentage");
  } else if (Object.keys(params).length)
    reject(field, "only gradual rollout accepts parameters");
  return value;
}
```

## Validation feedback

Keep the rule in [contracts.js](../src/server/contracts.js). A useful message names the field and expected type or range: “parameters.rollout must be an integer from 0 to 100.” Check that the value is a number before checking its range; coercing `"25"` would expand the contract unintentionally. Test both boundaries and at least one wrong type. At the service level, compare accepted state before and after rejection. This demonstrates that validation happens before a write is published.

Do not construct an error by echoing an entire incoming body. It could include a credential or a large payload. Error text is part of the API contract and should communicate what the caller can fix without disclosing unrelated state.

## Archive filtering

Represent the filter as a small explicit value, for example `all`, `active`, or `archived`. Apply authorization on the server as before, then apply the local view filter before calculating page count. Reset or clamp the page when search/filter changes. Keep `state.editor` independent of the filtered list: a record falling out of a view should not erase an unsaved draft. If the interface chooses to change the selected record, ask through the existing draft-discard flow.

A meaningful browser case starts with multiple pages, selects the later page, changes the filter to a single record, and expects page one with one result. Another assertion confirms that changing a filter does not emit a mutation request. Avoid a test that merely repeats the same filtering expression as the implementation; observe rendered records and user behavior.

## Reference-aware deletion feedback

Resolve blockers only after authorizing access to the target and every detail you return. A structured response might provide a stable error code and authorized resource identifiers, while the UI translates them into links. Preserve a generic refusal for details the actor cannot see. Do not remove the existing service guard because the interface now warns first: another API caller can skip the warning.

The strongest regression proves both directions of the rule. While the segment is referenced, deletion refuses and state remains unchanged. After the strategy stops referencing it, deletion succeeds and history records the accepted change. This is more informative than asserting that a particular helper function was called.

## Durable receipts

A receipt belongs in the same atomic draft as the creation. Look up `(actor, operation, requestId)` under the writer lease; compare a canonical payload fingerprint; return the previous identity for a matching replay; reject mismatched reuse. Bound request identifiers and receipt retention. A restarted process must load receipts from persisted state. Decide how a deleted original record is represented on later replay rather than accidentally recreating it.

For a token, storing the plaintext just to replay the response changes the security model. A safer policy may return a creation identifier while requiring revocation and replacement when the one-time secret is lost. Document the policy explicitly. A timeout is a fact about the client's observation, not proof that the server rolled back.

## Relational migration

Use explicit foreign keys for ownership and references, unique constraints for domain identifiers, and a transaction for an accepted mutation plus audit history. Model deletion rules intentionally: shared segment references should restrict deletion, while owned variants can cascade with a strategy. Preserve protected-environment confirmation as an application rule; a foreign key cannot express the user's acknowledgment.

For review, lead with the concrete problem and resulting behavior. Then explain the narrow implementation choice, relevant tests, and remaining limitations. A useful description is: “An archived-only filter now resets an out-of-range page while preserving the open draft. Verified with a two-page browser fixture and a retained unsaved edit.” Avoid claiming complete reliability from one passing screenshot. Mid-level judgment includes deciding what evidence is sufficient and naming what it does not cover.
