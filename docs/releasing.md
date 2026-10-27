# Releasing

[← Back to the README](../README.md)

For maintainers. A release is a version tag; the [image workflow](../.github/workflows/image.yml) does the rest.

## Cut a release

1. Set `version` in `package.json` to the new number (for example `0.2.0`) and merge that to the main branch.
2. Tag the commit and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

   The workflow refuses a tag that does not match `package.json`, so the two cannot drift apart.
3. Watch the **Image** workflow. When it is green there is a GitHub release with generated notes, and the image has its tags: `0.2.0`, `0.2` and `latest`. A tag with a dash, such as `v0.3.0-rc.1`, publishes only under its own name and is marked as a pre-release on GitHub, so `latest` and `0.3` never point at it.

## What the workflow does

1. **Build.** One build for x86-64 and ARM64, pushed by digest with **no tag**, with build provenance and a software bill of materials attached.
2. **Test the pushed image.** On that exact digest it runs the Docker end-to-end test and the Kubernetes end-to-end test (on a throwaway kind cluster), and starts the ARM64 half under emulation and checks it answers.
3. **Tag.** Only when every test passes, it gives the digest its tags and, for a version tag, creates the GitHub release. A failed test therefore leaves the old `latest` where it was.

A push to the main branch goes through the same steps and publishes `edge`. A manual run (**Actions → Image → Run workflow**) publishes whatever tag you type, to try the workflow out; it can never publish `latest` or `edge`.

## Make the package public

GitHub creates the image package as **private**, linked to the repository. Nobody but collaborators can pull it until you change that, once, after the first image is published:

1. Open the repository's **Packages** and choose the package.
2. **Package settings → Danger zone → Change visibility → Public.**

Do this at the same time the repository is made public.

## If a release is bad

Tags are not moved after publishing, so fix forward: release the next patch version. If a published version must not be used, delete that tag's version in the package's settings and mark the GitHub release as a pre-release or delete it. `latest` moves again on the next good release.

## Before the first public release

- Make the repository public, then the package (above).
- The documentation names this repository's owner in the clone and image commands. If you fork or rename the project, search for that name and replace it. The workflow itself computes the image name from the repository and needs no change.
