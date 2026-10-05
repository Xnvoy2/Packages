/* Anchor tests for the package identity program.
 *
 * NOT YET RUN. There is no Rust toolchain on the machine these were written
 * on, so the program has never been compiled and these have never executed.
 * They are written against the program as it stands so that `anchor test` is
 * a single command once a toolchain exists, rather than the next task.
 *
 *   cd solana
 *   anchor build
 *   anchor test
 *
 * Every negative case asserts a specific failure, not merely that something
 * threw: a test that passes because the program is broken in a different way
 * is worse than no test.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { createHash } from "crypto";
import { assert } from "chai";

import { PackageIdentity } from "../target/types/package_identity";

const PACKAGE_SEED = Buffer.from("package");
const CONFIG_SEED = Buffer.from("config");
const RELEASE_SEED = Buffer.from("release");

/* Must match package_hash() in the program and nameHash() in
   api/lib/solana.js. If these three disagree the product shows addresses
   nothing lives at. */
const nameHash = (name: string) =>
  createHash("sha256").update(Buffer.from(name, "utf8")).digest();

const versionHash = (version: string) =>
  createHash("sha256").update(Buffer.from(version, "utf8")).digest();

describe("package_identity", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PackageIdentity as Program<PackageIdentity>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const registrar = Keypair.generate();
  const owner = Keypair.generate();
  const attacker = Keypair.generate();

  const configPda = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    program.programId
  )[0];

  const identityFor = (name: string) =>
    PublicKey.findProgramAddressSync(
      [PACKAGE_SEED, nameHash(name)],
      program.programId
    )[0];

  const releaseFor = (identity: PublicKey, version: string) =>
    PublicKey.findProgramAddressSync(
      [RELEASE_SEED, identity.toBuffer(), versionHash(version)],
      program.programId
    )[0];

  before(async () => {
    for (const kp of [registrar, owner, attacker]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2e9);
      await provider.connection.confirmTransaction(sig);
    }
  });

  it("initialises once, naming the registrar", async () => {
    await program.methods
      .initialize(registrar.publicKey)
      .accounts({ config: configPda, admin: admin.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.registrar.toBase58(), registrar.publicKey.toBase58());
    assert.equal(config.admin.toBase58(), admin.publicKey.toBase58());
    assert.isFalse(config.paused);
  });

  it("registers a package the registrar authorises", async () => {
    const name = "left-pad";
    const identity = identityFor(name);

    await program.methods
      .registerIdentity(name, new anchor.BN(17740831), "stevemao/left-pad", new anchor.BN(4242), 1)
      .accounts({
        config: configPda,
        identity,
        owner: owner.publicKey,
        registrar: registrar.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([registrar])
      .rpc();

    const account = await program.account.identity.fetch(identity);
    assert.equal(account.name, name);
    assert.equal(account.owner.toBase58(), owner.publicKey.toBase58());
    // The registrar is recorded, so a reader can see whose word this rests on.
    assert.equal(account.registrar.toBase58(), registrar.publicKey.toBase58());
    assert.equal(account.repoId.toNumber(), 17740831);
    assert.equal(account.verificationKind, 1);
    assert.equal(account.releaseCount.toNumber(), 0);
  });

  it("refuses a registration the registrar did not sign", async () => {
    const identity = identityFor("express");
    try {
      await program.methods
        .registerIdentity("express", new anchor.BN(1), "expressjs/express", new anchor.BN(1), 1)
        .accounts({
          config: configPda,
          identity,
          owner: attacker.publicKey,
          registrar: attacker.publicKey,
          payer: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("a stranger registered a package");
    } catch (e: any) {
      assert.include(e.toString(), "NotRegistrar");
    }
  });

  it("refuses a duplicate registration", async () => {
    const identity = identityFor("left-pad");
    try {
      await program.methods
        .registerIdentity("left-pad", new anchor.BN(1), "someone/else", new anchor.BN(1), 1)
        .accounts({
          config: configPda,
          identity,
          owner: attacker.publicKey,
          registrar: registrar.publicKey,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([registrar])
        .rpc();
      assert.fail("a package was registered twice");
    } catch (e: any) {
      // init on an existing account: the runtime refuses it, not a check.
      assert.match(e.toString(), /already in use|custom program error: 0x0/);
    }
  });

  it("refuses a name that is not canonical", async () => {
    for (const name of ["Left-Pad", ".hidden", "_private", "has space", "@scope", "@a/b/c"]) {
      const identity = identityFor(name);
      try {
        await program.methods
          .registerIdentity(name, new anchor.BN(1), "a/b", new anchor.BN(1), 1)
          .accounts({
            config: configPda,
            identity,
            owner: owner.publicKey,
            registrar: registrar.publicKey,
            payer: admin.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([registrar])
          .rpc();
        assert.fail(`registered a non-canonical name: ${name}`);
      } catch (e: any) {
        assert.include(e.toString(), "NameNotCanonical", `for ${name}`);
      }
    }
  });

  it("registers a scoped name, and it does not collide with its unscoped form", async () => {
    const scoped = "@babel/core";
    const identity = identityFor(scoped);

    await program.methods
      .registerIdentity(scoped, new anchor.BN(5024), "babel/babel", new anchor.BN(9), 2)
      .accounts({
        config: configPda,
        identity,
        owner: owner.publicKey,
        registrar: registrar.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([registrar])
      .rpc();

    const account = await program.account.identity.fetch(identity);
    assert.equal(account.name, scoped);
    assert.notEqual(identityFor("@babel/core").toBase58(), identityFor("babel/core").toBase58());
  });

  it("registers a name far longer than a seed", async () => {
    // 200 characters: impossible under the old literal-seed scheme.
    const name = "a".repeat(200);
    const identity = identityFor(name);

    await program.methods
      .registerIdentity(name, new anchor.BN(0), "", new anchor.BN(0), 1)
      .accounts({
        config: configPda,
        identity,
        owner: owner.publicKey,
        registrar: registrar.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([registrar])
      .rpc();

    const account = await program.account.identity.fetch(identity);
    assert.equal(account.name.length, 200);
  });

  it("records a release, and refuses to record it twice", async () => {
    const identity = identityFor("left-pad");
    const version = "1.3.0";
    const release = releaseFor(identity, version);
    const hash = Array.from(createHash("sha256").update("packages.release.v1").digest());

    await program.methods
      .recordRelease(version, hash, new anchor.BN(1523236245))
      .accounts({
        config: configPda,
        identity,
        release,
        registrar: registrar.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([registrar])
      .rpc();

    const record = await program.account.release.fetch(release);
    assert.equal(record.version, version);

    const after = await program.account.identity.fetch(identity);
    assert.equal(after.releaseCount.toNumber(), 1);

    // Append-only: the same version cannot be written again.
    try {
      await program.methods
        .recordRelease(version, hash, new anchor.BN(1))
        .accounts({
          config: configPda,
          identity,
          release,
          registrar: registrar.publicKey,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([registrar])
        .rpc();
      assert.fail("a release record was overwritten");
    } catch (e: any) {
      assert.match(e.toString(), /already in use|custom program error: 0x0/);
    }
  });

  it("refuses a release the registrar did not sign", async () => {
    const identity = identityFor("left-pad");
    const release = releaseFor(identity, "9.9.9");
    try {
      await program.methods
        .recordRelease("9.9.9", Array(32).fill(0), new anchor.BN(1))
        .accounts({
          config: configPda,
          identity,
          release,
          registrar: attacker.publicKey,
          payer: attacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();
      assert.fail("a stranger recorded a release");
    } catch (e: any) {
      assert.include(e.toString(), "NotRegistrar");
    }
  });

  it("requires both the owner and the registrar to transfer", async () => {
    const identity = identityFor("left-pad");
    const newOwner = Keypair.generate();

    // Owner alone is not enough.
    try {
      await program.methods
        .transferIdentity(newOwner.publicKey)
        .accounts({ config: configPda, identity, owner: owner.publicKey, registrar: owner.publicKey })
        .signers([owner])
        .rpc();
      assert.fail("transferred without the registrar");
    } catch (e: any) {
      assert.include(e.toString(), "NotRegistrar");
    }

    // Registrar alone is not enough either.
    try {
      await program.methods
        .transferIdentity(newOwner.publicKey)
        .accounts({ config: configPda, identity, owner: attacker.publicKey, registrar: registrar.publicKey })
        .signers([attacker, registrar])
        .rpc();
      assert.fail("transferred without the real owner");
    } catch (e: any) {
      assert.include(e.toString(), "NotOwner");
    }

    // Both together succeed.
    await program.methods
      .transferIdentity(newOwner.publicKey)
      .accounts({ config: configPda, identity, owner: owner.publicKey, registrar: registrar.publicKey })
      .signers([owner, registrar])
      .rpc();

    const account = await program.account.identity.fetch(identity);
    assert.equal(account.owner.toBase58(), newOwner.publicKey.toBase58());
  });

  it("pausing stops new registrations and leaves existing ones alone", async () => {
    await program.methods
      .setPaused(true)
      .accounts({ config: configPda, admin: admin.publicKey })
      .rpc();

    try {
      await program.methods
        .registerIdentity("vite", new anchor.BN(1), "vitejs/vite", new anchor.BN(1), 1)
        .accounts({
          config: configPda,
          identity: identityFor("vite"),
          owner: owner.publicKey,
          registrar: registrar.publicKey,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([registrar])
        .rpc();
      assert.fail("registered while paused");
    } catch (e: any) {
      assert.include(e.toString(), "Paused");
    }

    // What was already registered is untouched and still readable.
    const existing = await program.account.identity.fetch(identityFor("left-pad"));
    assert.equal(existing.name, "left-pad");

    await program.methods
      .setPaused(false)
      .accounts({ config: configPda, admin: admin.publicKey })
      .rpc();
  });

  it("refuses an admin action from a stranger", async () => {
    try {
      await program.methods
        .setRegistrar(attacker.publicKey)
        .accounts({ config: configPda, admin: attacker.publicKey })
        .signers([attacker])
        .rpc();
      assert.fail("a stranger changed the registrar");
    } catch (e: any) {
      assert.include(e.toString(), "NotAdmin");
    }
  });

  it("refuses an unknown verification kind", async () => {
    try {
      await program.methods
        .registerIdentity("zod", new anchor.BN(1), "colinhacks/zod", new anchor.BN(1), 99)
        .accounts({
          config: configPda,
          identity: identityFor("zod"),
          owner: owner.publicKey,
          registrar: registrar.publicKey,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([registrar])
        .rpc();
      assert.fail("accepted an unknown verification kind");
    } catch (e: any) {
      assert.include(e.toString(), "UnknownVerificationKind");
    }
  });
});
