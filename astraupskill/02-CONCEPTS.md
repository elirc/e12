# Concepts behind reliable administration CRUD

## Identity, scope, and membership answer different questions

Authentication asks which persisted token and user a request represents. A token scope limits the operations it may perform. Project membership determines where the user may perform them. A `write` scope does not make someone an instance administrator, and membership in Checkout does not permit editing another project's flags. Read the checks in [services.js](../src/server/services.js) and the adversarial examples in [authorization.test.js](../test/authorization.test.js).

Imagine a project member whose legacy token accidentally contains `admin`. Global project creation still requires the instance-administrator role. Conversely, an administrator using a read-only token should not gain write access merely because of their user role. The effective permission is the intersection of relevant identity, scope, and relationship requirements. Browser controls explain this permission to the user; the server must enforce it independently.

## PATCH omission differs from false and empty

Suppose the accepted record is `{description: "Old text", stale: true}`. A PATCH `{description: ""}` intentionally clears the description and leaves `stale` unchanged. A PATCH `{stale: false}` intentionally unmarks it. Code such as `if (input.stale)` loses the second operation. Code that fills omitted fields with form defaults can overwrite another editor's accepted values. The [contracts](../src/server/contracts.js) and browser `changes()` function preserve these distinctions.

Validation has layers. The HTTP boundary limits malformed or oversized requests. Resource contracts reject unknown fields, wrong types, and invalid shapes. Services validate relationships, permissions, limits, and the resulting domain state. Storage validates the representation it will persist. An integer weight of 60 is locally valid, but two sibling weights of 60 violate the collection invariant that variants total 100. That final rule cannot be checked by looking at one field alone.

## Optimistic concurrency protects edits

The workspace has a global revision. An editor loads revision 8, and sends `If-Match: "8"` when saving. If another accepted mutation advances it to 9, the stale write is refused. The user can load the latest record, compare it with the draft, and explicitly continue. Global revisioning is simple but causes conflicts even when two editors changed unrelated records. Recognize that tradeoff before proposing per-record revisions, which complicate operations spanning projects, mappings, strategies, and audit entries.

A conflict is different from an uncertain response. After a network failure, the server may already have accepted the request. Retrying a POST can create another record. This application blocks further writes and asks for a review of accepted state; it does not implement durable request receipts. Unique keys help identify a creation, but they are not a universal idempotency protocol. One-time token plaintext is especially sensitive: if its creation response is lost, the stored hash cannot recover the secret.

## Durability and visibility are separate events

In [storage.js](../src/server/storage.js), state becomes visible after replacement of the accepted file. Publishing a draft in memory before saving it would let readers observe an unaccepted change when a disk operation fails. The writer lease protects cooperating processes during comparison and replacement. The digest detects external file edits even when someone did not advance the revision. These mechanisms support local learning; they do not establish a distributed transaction or guarantee survival of every power-loss scenario.

## Cache configuration, evaluate context

A snapshot revision says which configuration was used. It does not identify a user's evaluation result. Consider a rule allowing only `plan: "pro"`. Two requests with identical configuration but different plans must produce different decisions. Reusing a 304 response as “the user's flags have not changed” is invalid unless the complete context and all other relevant inputs are part of the cache contract. The simpler approach here evaluates each submitted context and uses the snapshot cache only for configuration compilation.

## Delete policy communicates ownership

Owned variants can disappear with their strategy. A referenced segment cannot disappear while another strategy needs it. Archived flags with retained metrics cannot be deleted through a casual cascade. These policies protect meaning, not just database consistency. Before adding any DELETE route, write down which records are owned, which are shared, which history must survive, and what a user sees when deletion is refused. That reasoning transfers directly to orders, invoices, teams, support tickets, and other business applications.
