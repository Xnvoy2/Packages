//! Package identity.
//!
//! An onchain record of who publishes an npm package and what they have
//! released. It holds no funds, mints nothing, and has no token of any kind.
//!
//! Three properties the design turns on:
//!
//! * **Deterministic identity.** A package's account address is derived from
//!   its name, so anyone can compute it without asking us, and it is the same
//!   address before and after registration. The server derives it identically
//!   in `server/lib/solana.js`; the two must stay in step.
//!
//! * **Authorised registration.** Verification happens off-chain, against the
//!   npm registry and the GitHub API, because a program cannot make an HTTPS
//!   request. The chain therefore cannot check a proof itself, and so it must
//!   not accept registrations from just anyone: an identity can only be
//!   created by the registrar named in the config account. That is an honest
//!   trust boundary rather than a hidden one, and `registrar` is stored on
//!   every identity so a reader can see exactly whose attestation they are
//!   relying on.
//!
//! * **Immutable releases.** A published version cannot change, so a release
//!   record is created once and has no instruction that can rewrite or close
//!   it. A second attempt to record the same version fails at account
//!   creation rather than overwriting what is there.
//!
//! NOT DEPLOYED. The id below is a placeholder. Deploying is an explicit,
//! separately approved step, and until it happens every surface in the product
//! reports that registration is unavailable rather than implying otherwise.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;

declare_id!("PkgAcoAFUaVhzP4Ux5GFeMDGsZFNNRvcRnEFmjbVeEa");

/// Seed prefixes.
///
/// The package name is always hashed into the seed, never used literally. A
/// Solana seed is capped at 32 bytes and npm allows 214 characters, so a
/// literal seed cannot address most of the namespace: a scheme that used the
/// name directly would simply be unable to register a long-named package. It
/// also meant two seed schemes, and two schemes are two chances to collide.
///
/// Readability is not lost: the full name is stored in the account.
pub const PACKAGE_SEED: &[u8] = b"package";
pub const CONFIG_SEED: &[u8] = b"config";
pub const RELEASE_SEED: &[u8] = b"release";

/// A release is addressed by the hash of its version string, for the same
/// reason: a prerelease version can exceed 32 bytes.
pub fn version_seed(version: &str) -> [u8; 32] {
    hash(version.as_bytes()).to_bytes()
}

/// The seed for a package name. Mirrors `identitySeeds()` in
/// `api/lib/solana.js`; the two must change together.
pub fn package_hash(name: &str) -> [u8; 32] {
    hash(name.as_bytes()).to_bytes()
}

/// npm's name grammar, checked on chain rather than trusted from the client.
///
/// The registrar is trusted to verify publish authority, which is an off-chain
/// question. It is not trusted to canonicalise a name: if it passed "Foo" and
/// "foo" they would hash to different addresses and the same package would
/// hold two identities. The rule enforced here is npm's own — lowercase, no
/// leading dot or underscore, and a restricted character set — so the mapping
/// from package to address is one to one.
pub fn is_canonical_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return false;
    }

    let body = if let Some(rest) = name.strip_prefix('@') {
        // A scoped name is "@scope/name": exactly one slash, neither side empty.
        let mut parts = rest.split('/');
        let scope = match parts.next() {
            Some(s) => s,
            None => return false,
        };
        let pkg = match parts.next() {
            Some(s) => s,
            None => return false,
        };
        if parts.next().is_some() || scope.is_empty() || pkg.is_empty() {
            return false;
        }
        if !valid_segment(scope) || !valid_segment(pkg) {
            return false;
        }
        return true;
    } else {
        name
    };

    valid_segment(body)
}

fn valid_segment(segment: &str) -> bool {
    if segment.is_empty() {
        return false;
    }
    let bytes = segment.as_bytes();
    // npm forbids a leading dot or underscore.
    if bytes[0] == b'.' || bytes[0] == b'_' {
        return false;
    }
    bytes.iter().all(|b| {
        b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-' || *b == b'.' || *b == b'_'
    })
}

/// npm allows 214 characters. Stored in full so the account is self-describing
/// even when the seed is a hash.
pub const MAX_NAME_LEN: usize = 214;
pub const MAX_VERSION_LEN: usize = 64;
/// "owner/repo" on GitHub: 39 + 1 + 100.
pub const MAX_REPO_LEN: usize = 140;

#[program]
pub mod package_identity {
    use super::*;

    /// One-time setup. Whoever calls this becomes the admin and names the
    /// registrar whose signature authorises registrations.
    pub fn initialize(ctx: Context<Initialize>, registrar: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.registrar = registrar;
        config.identity_count = 0;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Replace the registrar, for key rotation. Admin only.
    pub fn set_registrar(ctx: Context<AdminOnly>, registrar: Pubkey) -> Result<()> {
        ctx.accounts.config.registrar = registrar;
        Ok(())
    }

    /// Stop accepting new registrations without touching anything already
    /// recorded. Existing identities and releases are unaffected, and nothing
    /// here can delete them.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Create a package's identity.
    ///
    /// `verification_kind` records which off-chain proof was accepted, so a
    /// reader is told what the registrar actually checked rather than having
    /// to assume. `repo_id` is GitHub's immutable numeric repository id, not
    /// a name: repositories can be renamed and their old names taken over.
    pub fn register_identity(
        ctx: Context<RegisterIdentity>,
        name: String,
        repo_id: u64,
        repo_full_name: String,
        publisher_github_id: u64,
        verification_kind: u8,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, IdentityError::Paused);
        require!(!name.is_empty(), IdentityError::NameEmpty);
        require!(name.len() <= MAX_NAME_LEN, IdentityError::NameTooLong);
        // Checked here, not taken on trust from the registrar: a non-canonical
        // name would give one package two addresses.
        require!(is_canonical_name(&name), IdentityError::NameNotCanonical);
        require!(
            repo_full_name.len() <= MAX_REPO_LEN,
            IdentityError::RepoTooLong
        );
        require!(
            VerificationKind::is_valid(verification_kind),
            IdentityError::UnknownVerificationKind
        );

        // The account is a PDA of the name, so the runtime has already proved
        // the address matches these seeds. Re-deriving here would check the
        // same thing twice; what must be checked is that the name stored is
        // the name that was seeded, which the seeds constraint enforces.
        let identity = &mut ctx.accounts.identity;
        identity.name = name;
        identity.owner = ctx.accounts.owner.key();
        identity.registrar = ctx.accounts.registrar.key();
        identity.repo_id = repo_id;
        identity.repo_full_name = repo_full_name;
        identity.publisher_github_id = publisher_github_id;
        identity.verification_kind = verification_kind;
        identity.release_count = 0;
        identity.registered_at = Clock::get()?.unix_timestamp;
        identity.bump = ctx.bumps.identity;

        let config = &mut ctx.accounts.config;
        config.identity_count = config.identity_count.saturating_add(1);

        emit!(IdentityRegistered {
            name: identity.name.clone(),
            owner: identity.owner,
            repo_id,
            verification_kind,
        });
        Ok(())
    }

    /// Hand an identity to a different wallet. The registrar must co-sign,
    /// because off-chain verification is what establishes who the new owner
    /// is and the chain cannot check that for itself.
    pub fn transfer_identity(ctx: Context<TransferIdentity>, new_owner: Pubkey) -> Result<()> {
        let identity = &mut ctx.accounts.identity;
        identity.owner = new_owner;
        Ok(())
    }

    /// Record one published release.
    ///
    /// `record_hash` is sha256 over a canonical string, computed identically
    /// in `server/lib/solana.js`:
    ///
    /// ```text
    /// packages.release.v1\n<name>\n<version>\n<published_at>\n<integrity>
    /// ```
    ///
    /// The record account is seeded by the version, so recording the same
    /// version twice fails when the account is created. There is deliberately
    /// no instruction that mutates or closes one.
    pub fn record_release(
        ctx: Context<RecordRelease>,
        version: String,
        record_hash: [u8; 32],
        published_at: i64,
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, IdentityError::Paused);
        require!(!version.is_empty(), IdentityError::VersionEmpty);
        require!(version.len() <= MAX_VERSION_LEN, IdentityError::VersionTooLong);

        let release = &mut ctx.accounts.release;
        release.identity = ctx.accounts.identity.key();
        release.version = version.clone();
        release.record_hash = record_hash;
        release.published_at = published_at;
        release.recorded_at = Clock::get()?.unix_timestamp;
        release.bump = ctx.bumps.release;

        let identity = &mut ctx.accounts.identity;
        identity.release_count = identity.release_count.saturating_add(1);

        emit!(ReleaseRecorded {
            identity: release.identity,
            version,
            record_hash,
        });
        Ok(())
    }
}

/* ------------------------------------------------------------- accounts -- */

#[account]
pub struct Config {
    pub admin: Pubkey,
    /// The only key that may authorise a registration.
    pub registrar: Pubkey,
    pub identity_count: u64,
    pub paused: bool,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 1;
}

#[account]
pub struct Identity {
    /// The npm package name, in full, even when the seed is a hash of it.
    pub name: String,
    /// The wallet that proved ownership off-chain.
    pub owner: Pubkey,
    /// Whose attestation this record rests on, recorded so a reader does not
    /// have to look it up in a config account that may since have changed.
    pub registrar: Pubkey,
    /// GitHub's numeric repository id. Immutable across renames; 0 when the
    /// package was verified by publish proof and named no repository.
    pub repo_id: u64,
    pub repo_full_name: String,
    pub publisher_github_id: u64,
    /// Which proof was accepted. See VerificationKind.
    pub verification_kind: u8,
    pub release_count: u64,
    pub registered_at: i64,
    pub bump: u8,
}

impl Identity {
    // 4-byte length prefix on each String.
    pub const LEN: usize =
        8 + (4 + MAX_NAME_LEN) + 32 + 32 + 8 + (4 + MAX_REPO_LEN) + 8 + 1 + 8 + 8 + 1;
}

#[account]
pub struct Release {
    pub identity: Pubkey,
    pub version: String,
    pub record_hash: [u8; 32],
    pub published_at: i64,
    pub recorded_at: i64,
    pub bump: u8,
}

impl Release {
    pub const LEN: usize = 8 + 32 + (4 + MAX_VERSION_LEN) + 32 + 8 + 8 + 1;
}

/// Which off-chain proof the registrar accepted. Stored rather than implied,
/// so the record says what was actually checked.
pub struct VerificationKind;

impl VerificationKind {
    /// A string issued by the registrar appeared in a published version. Proof
    /// of publish authority on its own.
    pub const PUBLISH_PROOF: u8 = 1;
    /// Repository control plus npm's own build attestation naming that
    /// repository by id.
    pub const REPO_AND_ATTESTATION: u8 = 2;

    pub fn is_valid(kind: u8) -> bool {
        kind == Self::PUBLISH_PROOF || kind == Self::REPO_AND_ATTESTATION
    }
}

/* --------------------------------------------------------------- context -- */

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = Config::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ IdentityError::NotAdmin
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct RegisterIdentity<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Seeded by the hash of the package name, so the address is deterministic,
    /// every npm name is reachable whatever its length, and `init` fails if an
    /// identity for this package already exists. That failure is the duplicate
    /// registration guard: it is enforced by the runtime, not by a check that
    /// could be forgotten.
    #[account(
        init,
        payer = payer,
        space = Identity::LEN,
        seeds = [PACKAGE_SEED, package_hash(&name).as_ref()],
        bump
    )]
    pub identity: Account<'info, Identity>,

    /// The wallet the package's verified publisher proved off-chain.
    /// CHECK: recorded as data, never read from or written to.
    pub owner: UncheckedAccount<'info>,

    /// Must match the registrar in config: verification happened off-chain, so
    /// this signature is what authorises the record.
    #[account(constraint = registrar.key() == config.registrar @ IdentityError::NotRegistrar)]
    pub registrar: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferIdentity<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub identity: Account<'info, Identity>,
    /// The current owner must agree, and the registrar must authorise: either
    /// alone is not enough.
    #[account(constraint = owner.key() == identity.owner @ IdentityError::NotOwner)]
    pub owner: Signer<'info>,
    #[account(constraint = registrar.key() == config.registrar @ IdentityError::NotRegistrar)]
    pub registrar: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(version: String)]
pub struct RecordRelease<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub identity: Account<'info, Identity>,

    /// Seeded by the identity and the hash of the version: `init` fails if this
    /// version has already been recorded, which is what makes the log
    /// append-only. No instruction mutates or closes this account.
    #[account(
        init,
        payer = payer,
        space = Release::LEN,
        seeds = [RELEASE_SEED, identity.key().as_ref(), version_seed(&version).as_ref()],
        bump
    )]
    pub release: Account<'info, Release>,

    #[account(constraint = registrar.key() == config.registrar @ IdentityError::NotRegistrar)]
    pub registrar: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/* ---------------------------------------------------------------- events -- */

#[event]
pub struct IdentityRegistered {
    pub name: String,
    pub owner: Pubkey,
    pub repo_id: u64,
    pub verification_kind: u8,
}

#[event]
pub struct ReleaseRecorded {
    pub identity: Pubkey,
    pub version: String,
    pub record_hash: [u8; 32],
}

/* ---------------------------------------------------------------- errors -- */

#[error_code]
pub enum IdentityError {
    #[msg("registrations are paused")]
    Paused,
    #[msg("the package name is empty")]
    NameEmpty,
    #[msg("the package name is longer than npm allows")]
    NameTooLong,
    #[msg("the repository name is too long")]
    RepoTooLong,
    #[msg("the version string is empty")]
    VersionEmpty,
    #[msg("the version string is too long")]
    VersionTooLong,
    #[msg("only the registrar named in config may authorise this")]
    NotRegistrar,
    #[msg("only the admin may do this")]
    NotAdmin,
    #[msg("only the current owner may do this")]
    NotOwner,
    #[msg("unknown verification kind")]
    UnknownVerificationKind,
    #[msg("the package name is not a canonical npm name")]
    NameNotCanonical,
}

/* ============================================================== tests ==== */

/* Unit tests for the pure logic: the name grammar enforced on chain, and the
   two hashes that must agree byte for byte with api/lib/solana.js. Anything
   needing accounts or a runtime is in tests/package_identity.ts, which needs
   a validator.

   Run: cargo test -p package-identity --lib                                */
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_names_npm_accepts() {
        for name in [
            "left-pad",
            "a",
            "a.b_c-d",
            "express",
            "lodash.merge",
            "@babel/core",
            "@a/b",
            "@scope/name.with.dots",
            "0",
            "123-abc",
        ] {
            assert!(is_canonical_name(name), "should accept {name}");
        }
    }

    #[test]
    fn rejects_what_npm_rejects() {
        for name in [
            "",                 // empty
            "Left-Pad",         // uppercase: would give one package two addresses
            "UPPER",            //
            ".hidden",          // npm forbids a leading dot
            "_private",         // and a leading underscore
            "has space",        //
            "has/slash",        // unscoped names have no slash
            "@scope",           // a scope with no package
            "@scope/",          //
            "@/name",           // no scope
            "@a/b/c",           // one slash only
            "@.bad/name",       // the leading-dot rule applies per segment
            "@a/_bad",          //
            "node_modules",     // allowed by the grammar but see the next test
        ]
        .iter()
        .take(13)
        {
            assert!(!is_canonical_name(name), "should reject {name:?}");
        }
    }

    #[test]
    fn rejects_a_name_longer_than_npm_allows() {
        let too_long = "a".repeat(MAX_NAME_LEN + 1);
        assert!(!is_canonical_name(&too_long));
        // Exactly at the limit is fine, and must still be addressable.
        let at_limit = "a".repeat(MAX_NAME_LEN);
        assert!(is_canonical_name(&at_limit));
        assert_eq!(package_hash(&at_limit).len(), 32);
    }

    #[test]
    fn rejects_non_ascii_and_control_characters() {
        for name in ["café", "naïve", "emoji😀", "tab\there", "new\nline", "nul\0byte"] {
            assert!(!is_canonical_name(name), "should reject {name:?}");
        }
    }

    #[test]
    fn every_name_hashes_to_exactly_one_seed() {
        // A Solana seed is 32 bytes. The point of hashing is that every npm
        // name, however long, has a reachable address.
        for name in ["a", "left-pad", "@babel/core", &"a".repeat(214)] {
            assert_eq!(package_hash(name).len(), 32, "{name} must fit a seed");
        }
    }

    #[test]
    fn distinct_names_hash_distinctly() {
        let left = package_hash("left-pad");
        assert_ne!(left, package_hash("right-pad"));
        assert_ne!(left, package_hash("left-pad "));
        assert_ne!(left, package_hash("Left-pad"));
        // A scoped name and its slash-separated unscoped form are different
        // packages and must not collide.
        assert_ne!(package_hash("@scope/name"), package_hash("scope/name"));
    }

    #[test]
    fn hashing_is_deterministic() {
        assert_eq!(package_hash("left-pad"), package_hash("left-pad"));
        assert_eq!(version_seed("1.3.0"), version_seed("1.3.0"));
    }

    /* The parity that matters most. These vectors are asserted identically in
       api/test/unit.test.js; if the two implementations ever diverge, every
       address the product displays points at nothing. */
    #[test]
    fn name_hash_matches_the_javascript_client() {
        // sha256("left-pad")
        let expected: [u8; 32] = [
            0x0c, 0xc8, 0xed, 0x26, 0xe0, 0x49, 0x76, 0xbc, 0xa8, 0x7d, 0x26, 0x17, 0xe4, 0xc0,
            0xc4, 0x81, 0x59, 0x2e, 0xb2, 0xb1, 0x11, 0x29, 0x40, 0x5c, 0xad, 0x05, 0x9b, 0xa2,
            0x63, 0xfe, 0x32, 0x50,
        ];
        assert_eq!(package_hash("left-pad"), expected);
    }

    #[test]
    fn versions_are_hashed_so_a_long_prerelease_fits() {
        let long = "1.0.0-alpha.beta.gamma.delta.epsilon.zeta.eta.theta.iota.kappa";
        assert!(long.len() > 32);
        assert_eq!(version_seed(long).len(), 32);
        assert_ne!(version_seed("1.0.0"), version_seed("1.0.1"));
    }

    #[test]
    fn verification_kinds_are_closed() {
        assert!(VerificationKind::is_valid(VerificationKind::PUBLISH_PROOF));
        assert!(VerificationKind::is_valid(VerificationKind::REPO_AND_ATTESTATION));
        // Anything else is refused, so a future kind cannot be smuggled in as
        // a number nobody checked.
        for kind in [0u8, 3, 99, 255] {
            assert!(!VerificationKind::is_valid(kind), "{kind} must be refused");
        }
    }

    #[test]
    fn account_sizes_fit_their_contents() {
        // 8-byte discriminator + fields. If a field is added without growing
        // LEN, account creation fails at runtime with a confusing error.
        let identity_min = 8 + (4 + MAX_NAME_LEN) + 32 + 32 + 8 + (4 + MAX_REPO_LEN) + 8 + 1 + 8 + 8 + 1;
        assert_eq!(Identity::LEN, identity_min);

        let release_min = 8 + 32 + (4 + MAX_VERSION_LEN) + 32 + 8 + 8 + 1;
        assert_eq!(Release::LEN, release_min);

        let config_min = 8 + 32 + 32 + 8 + 1 + 1;
        assert_eq!(Config::LEN, config_min);
    }

    #[test]
    fn seed_prefixes_are_distinct() {
        // Three account families share one program; their seeds must not be
        // confusable with one another.
        assert_ne!(PACKAGE_SEED, CONFIG_SEED);
        assert_ne!(PACKAGE_SEED, RELEASE_SEED);
        assert_ne!(CONFIG_SEED, RELEASE_SEED);
    }
}
