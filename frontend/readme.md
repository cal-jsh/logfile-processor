### Install

```shell
npm install --legacy-peer-deps
```

### Run the desktop app (Vite dev server + app window)

```shell
npm run desktop
```

### Build the release exe and installers

```shell
npm run desktop:build
```

The UI talks to the viewport API from `backend/`, which the Tauri shell in
`src-tauri/` runs in-process on a random `127.0.0.1` port. The `LogSummary` type in
`src/lib/logSummary.ts` mirrors `backend/src/model/log_summary.rs`.
