# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull request.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and which way of running it you used (Cloudflare, Docker or Kubernetes) and which version or commit.

You can expect an acknowledgement, and a fix or a clear answer, as soon as the maintainers are able to look at it. This is a small project without a service-level agreement.

## Scope

In scope: the application in this repository, its Docker image and its Kubernetes manifests. For example sign-in and session handling, access to exports and original report files, handling of stored credentials, injection through report content, and anything that lets one visitor affect another.

Out of scope: problems in third-party software that this project only runs or links to (the upstream parser, Cloudflare, Docker, Kubernetes, your reverse proxy), and problems that need the attacker to already hold the admin login or the encryption key.

## What the application does to protect your data

[Security model](docs/security.md) describes it: how credentials are stored, how sign-in and throttling work, what the content-security policy allows, and why exports and original report files always require the login.

## Supported versions

Only the latest commit on the default branch is supported while the project is in its early stage.
