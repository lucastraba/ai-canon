# Contributing

Thanks for helping improve ai-canon.

1. Open an issue for substantial behavior or format changes so the compatibility impact is clear.
2. Create a focused branch and keep generated consumer state out of Git.
3. Add an end-to-end regression test for behavior changes, especially filesystem, ownership, Git-cache, and cross-platform paths.
4. Run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   pnpm test
   pnpm build
   pnpm pack
   ```

5. In the pull request, explain user impact, safety implications, and the commands you ran.

Do not include real credentials, private canon content, or absolute developer-machine paths in fixtures. Tests must use temporary directories and must not modify the caller's repository outside those fixtures.
