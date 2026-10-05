# Package identity: threat model

The program holds no funds and mints nothing. What it protects is the mapping

```
npm package  ->  verified publisher  ->  wallet  ->  release history
```

and the only thing an attacker gains by breaking it is the ability to make a
false statement about who publishes a package. That is the whole asset, and it
is enough: a package identity nobody can trust is worse than none.

**Status: the program has never been compiled.** There was no Rust toolchain
available and no disk space to install one, so everything below is reasoning
about the source, not a result from a test run. `anchor build` and `anchor
test` are the first things to do when a toolchain exists.

---

## The trust boundary, stated plainly

Verification is an off-chain question. Deciding whether somebody can publish
an npm package requires an HTTPS request to the registry, and a Solana program
cannot make one. So the chain cannot check a proof itself.

The program therefore **trusts one key**: the `registrar` named in the config
account. Every registration and every release record requires its signature.

This is a real centralisation, and it is recorded rather than hidden: the
`registrar` pubkey is stored on every `Identity` account, so a reader can see
exactly whose attestation an identity rests on, and can distinguish identities
registered under a key that was later rotated or compromised.

---

## Threats and what answers them

### Registering somebody else's package

The attacker calls `register_identity` with a package they do not publish.

Answered by the registrar signature. The instruction fails without it, and the
registrar only signs after the off-chain rule in `api/lib/verify.js` has passed:
a publish proof, or repository control together with npm's own build
attestation.

Residual risk: a compromised registrar key can register anything. Mitigations
available today are `set_registrar` for rotation and `set_paused` to stop new
registrations without touching existing ones. A multisig registrar is the
obvious hardening and is not implemented.

### Duplicate registration

Two identities for one package, or a second registration overwriting the first.

Answered by the account being a PDA of the package name with `init`. The
runtime fails the second attempt, so this cannot be forgotten in a code path —
it is not a check that could be missed, it is the account model.

### Package name canonicalisation

`Foo` and `foo` hash differently, so a careless registrar could create two
identities for one package.

Answered by `is_canonical_name`, which enforces npm's grammar on chain:
lowercase, no leading dot or underscore, the permitted character set, and for a
scoped name exactly one slash with neither side empty. The registrar is trusted
to verify authority, not to canonicalise input.

### Scoped package collisions

`@scope/name` and some other string hashing to the same seed.

Answered by hashing the exact utf-8 bytes of the full name with sha256. The
earlier design used the name literally when it was short enough and hashed it
otherwise, under a different prefix. That had two defects: a name over 32 bytes
could not be registered at all, because a Solana seed is capped at 32 bytes,
and two schemes are two chances to collide. There is now one scheme.

A test asserts that `@scope/name` and `scope/name` derive different addresses.

### Unauthorized authority transfer

An attacker moves an identity to their own wallet.

Answered by `transfer_identity` requiring **both** the current owner and the
registrar to sign. Either alone is insufficient: a stolen owner key cannot move
an identity without the registrar agreeing, and a compromised registrar cannot
move one without the owner.

### Fake release records

An attacker records a release that was never published.

Answered by the registrar signature, and by `record_hash` committing to the
package name, version, publish timestamp and tarball integrity in a canonical
string that anyone can recompute from the public registry. A fabricated record
is detectable by anyone who checks, which is the property worth having, since
the chain cannot prevent it.

### Rewriting history

Changing or deleting a release record after the fact.

Answered by there being no instruction that mutates or closes a `Release`
account. The account is seeded by the identity and the version hash, so a
second write to the same version fails at `init`. Append-only is enforced by
the account model, not by convention.

### Replay of a registration authorization

Re-sending an authorization to register something else, or again later.

Answered by the registrar co-signing the transaction itself rather than issuing
a standing authorization. There is no bearer token to replay: a transaction is
bound to its instruction data and its recent blockhash, and Solana rejects
duplicates. This is why there is deliberately no expiry field — there is no
standing grant that could go stale.

### Account substitution

Passing a different account where `identity` is expected, so a release is
recorded against the wrong package.

Partly answered: `Account<'info, Identity>` requires the account to be owned by
this program and to deserialise as an `Identity`, so an arbitrary account is
rejected. A registrar could still pass a valid but wrong identity. Since the
registrar is already trusted to assert the facts, this does not widen the trust
boundary, but constraining the release account's seeds against the package name
would make the instruction self-checking. **Worth doing before deployment.**

### Backend compromise

The server is owned.

This is the worst case, and the program cannot defend against it: whoever holds
the registrar key can register and record whatever they like. What limits the
damage is that the registrar is recorded per identity, so the blast radius is
identifiable after a rotation, and that existing release records cannot be
rewritten even by the registrar.

Keeping the registrar key in a KMS or on a hardware signer, rather than in the
api process, is the obvious mitigation and is not implemented.

---

## Not threats, by construction

- **Funds.** There are none. No instruction moves lamports beyond rent for the
  accounts being created, and no token of any kind exists.
- **Arbitrary data.** Every string is length-checked, and the name is checked
  against npm's grammar.
- **Integer overflow.** `release_count` and `identity_count` use
  `saturating_add`, and `overflow-checks = true` is set in the release profile.

---

## Before deployment

1. Compile it. None of this has been through a compiler.
2. `anchor test` against a local validator, including the negative cases in
   `tests/package_identity.ts`.
3. Constrain the `release` account's identity by seeds, as noted above.
4. Decide whether the registrar should be a multisig.
5. Decide where the registrar key lives. Not in the api process.
