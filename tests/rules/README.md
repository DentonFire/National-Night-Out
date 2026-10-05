# Local rules regression suite

Status on 2026-10-05 (Claude): **executed** with the Temurin JRE 21 already in `~/Dev/infra/toolchain/temurin-jre-21/`. `firestore.rules.proposed`: 14/14 pass. Live `firestore.rules`: all app writes and access checks pass; the 4 stricter-schema tests fail, as expected. `app-writes.test.mjs` replays writes exactly as `js/store.js` makes them (assign, atomic move, 21-party import transaction, Finalize/Unlock, Access).

Dependencies are isolated here and pinned to the client SDK version. After dependency and JDK setup has been authorized on a test machine:

```sh
cd tests/rules
npm install --ignore-scripts
cd ../..
export JAVA_HOME=~/Dev/infra/toolchain/temurin-jre-21/jdk-21.0.12.1+1-jre/Contents/Home PATH="$JAVA_HOME/bin:$PATH"
RULES_FILE="$PWD/firestore.rules" firebase emulators:exec --only firestore --project demo-nno \
  'cd tests/rules && node --test --test-concurrency=1 rules.test.mjs app-writes.test.mjs'
```

The suite uses only synthetic records, forces `demo-nno`, and rejects non-loopback endpoints. `initializeTestEnvironment` loads the worktree rules into the emulator. Never replace the project ID with a real project. Repeat the extra-field and malformed-value tests against the original rules to demonstrate the missing controls; the expected denials should fail there.

Run the files one at a time (`--test-concurrency=1`): they share one emulator and each clears it.
