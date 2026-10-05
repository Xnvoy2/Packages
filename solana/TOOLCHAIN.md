# Building the program on this machine

The program **type-checks and its unit tests run** here. What is still missing
is the SBF codegen step, which needs Solana's own LLVM toolchain.

## What was done

Windows has no C toolchain by default, and Rust needs a linker even for
`cargo check`, because build scripts and proc-macro crates are compiled to
executables and DLLs. The setup that works, none of it requiring admin rights
or touching the system:

1. `rustup-init.exe -y --no-modify-path --profile minimal`
2. `rustup toolchain install stable-x86_64-pc-windows-gnu --profile minimal`
3. A portable MinGW ([w64devkit](https://github.com/skeeto/w64devkit)),
   unzipped anywhere.
4. **Copy `libgcc.a` to `libgcc_eh.a`** in the devkit's
   `lib/gcc/x86_64-w64-mingw32/<version>/`. Rust's windows-gnu target links
   `-lgcc_eh`; w64devkit merges that into `libgcc` and ships no such file, and
   without the alias every build script fails to link.
5. Run with the devkit first on PATH and the linker named explicitly:

```cmd
set "DEVKIT=<path>\w64devkit\bin"
set "PATH=%DEVKIT%;%USERPROFILE%\.cargo\bin;%PATH%"
set "CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=%DEVKIT%\gcc.exe"
cargo +stable-x86_64-pc-windows-gnu check --target x86_64-pc-windows-gnu
cargo +stable-x86_64-pc-windows-gnu test  --target x86_64-pc-windows-gnu -p package-identity --lib
```

Both pass: the crate graph including `anchor-lang 0.30.1` compiles with no
errors, and 13 unit tests pass.

## What this does and does not prove

**Proved:** the program parses, type-checks and borrow-checks; every Anchor
derive macro expands; account size arithmetic is right; the name grammar and
both hashes behave as specified, including a vector asserting the Rust hash is
byte-identical to the JavaScript client's.

**Not proved:** that it links as an SBF object, its compute-unit cost, or any
behaviour needing accounts and a runtime. Those need `cargo build-sbf`, which
is part of the Solana platform tools.

## The remaining step

`cargo build-sbf` and `anchor test` are supported on Linux and macOS. On
Windows they need WSL, and **installing WSL requires administrator rights and
a reboot**, so it was not done.

On a Linux or macOS machine, or in WSL:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

cd solana
anchor build          # the SBF object
anchor test           # spins up a local validator and runs tests/package_identity.ts
```

`tests/package_identity.ts` is written and covers registration, duplicate
registration, non-canonical names, scoped names, a 200-character name, release
recording, duplicate release recording, authority transfer requiring both
signatures, pausing, and admin-only actions. It has never been executed.

Only after `anchor test` passes should deployment be considered, and that is a
separate, explicitly approved action.
