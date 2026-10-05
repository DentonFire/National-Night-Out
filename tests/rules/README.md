# Local rules regression suite

Status on 2026-10-05: written and syntax-checked; not executed because Java is absent. Do not treat source review as a passing rules test.

Dependencies are isolated here and pinned to the client SDK version. After dependency and JDK setup has been authorized on a test machine:

```sh
cd tests/rules
npm install --ignore-scripts
cd ../..
firebase emulators:exec --only firestore --project demo-nno --config firebase.json 'npm --prefix tests/rules test'
```

The suite uses only synthetic records, forces `demo-nno`, and rejects non-loopback endpoints. `initializeTestEnvironment` loads the worktree rules into the emulator. Never replace the project ID with a real project. Repeat the extra-field and malformed-value tests against the original rules to demonstrate the missing controls; the expected denials should fail there.
