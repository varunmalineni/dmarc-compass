#!/usr/bin/env python3
"""
Standalone IMAP connectivity check, independent of dmarc-compass and Cloudflare.

Confirms, in order: TLS connection, login, the exact folder names and casing
the server reports, and the message count in the folder you intend to use.
Run this first if the dashboard stays empty - it separates "my mailbox
settings are wrong" from "something is wrong in the deployment".

    python3 scripts/test-imap.py
    IMAP_HOST=imap.example.com IMAP_USER=dmarc@example.com python3 scripts/test-imap.py

The password is always prompted for (hidden) and never stored or printed.
"""
import getpass
import imaplib
import os
import sys


def main():
    host = os.environ.get("IMAP_HOST") or input("IMAP host: ").strip()
    port = int(os.environ.get("IMAP_PORT", "993"))
    user = os.environ.get("IMAP_USER") or input("IMAP user: ").strip()
    folder = os.environ.get("IMAP_FOLDER") or input("Folder to check [INBOX]: ").strip() or "INBOX"
    password = getpass.getpass(f"Password for {user}: ")

    print(f"\nConnecting to {host}:{port} over TLS...")
    try:
        conn = imaplib.IMAP4_SSL(host, port)
    except Exception as e:
        sys.exit(f"FAILED to open a TLS connection: {e}")
    print("TLS connection OK.")

    print(f"\nLogging in as {user}...")
    try:
        conn.login(user, password)
    except imaplib.IMAP4.error as e:
        print(f"FAILED to log in: {e}\n")
        print("Common causes:")
        print("  - wrong password (use an app-specific password if your provider offers one)")
        print("  - IMAP access is switched off for the account, or by an admin policy")
        print("  - you used an alias address; try the account's primary address")
        sys.exit(1)
    print("Login OK.")

    print("\nFolders on this account (names are case-sensitive):")
    status, folders = conn.list()
    if status == "OK":
        for f in folders:
            print(" ", f.decode(errors="replace"))

    print(f"\nSelecting '{folder}'...")
    status, data = conn.select(f'"{folder}"', readonly=True)
    if status != "OK":
        print(f"FAILED to select '{folder}': {data}")
        print("Check the exact name in the list above, including nesting (e.g. 'INBOX/Reports').")
        conn.logout()
        sys.exit(1)
    print(f"Selected. Messages in folder: {int(data[0])}")

    status, data = conn.search(None, "ALL")
    ids = data[0].split() if status == "OK" else []
    if ids:
        status, msg = conn.fetch(ids[-1], "(BODY[HEADER.FIELDS (SUBJECT FROM DATE)])")
        if status == "OK":
            print("\nMost recent message:")
            print(msg[0][1].decode(errors="replace").strip())

    conn.logout()
    print("\nIf the count above is greater than zero, the mailbox settings are correct.")


if __name__ == "__main__":
    main()
