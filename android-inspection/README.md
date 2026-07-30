# Inspection Android companion

This native client is intentionally narrower than Agent Approval. It can:

- list Whiteboard records and actor acknowledgements;
- create plain, unrouted Whiteboard notes;
- edit only an existing, server-approved Whiteboard body;
- delete only an existing, server-approved Whiteboard note;
- archive an ordinary note with a required, actor-attributed reason;
- view archived notes and restore them to the Whiteboard;
- list private channel/message envelopes without bodies.

It has no agent, task, wake, approval, message-send, tag, source, visibility, or
actor mutation API.

Build using the already provisioned Gradle wrapper:

```bash
/home/alu52/github/agent-console/android/gradlew \
  -p /home/alu52/github/personal-context-server/android-inspection \
  assembleDebug
```

On first launch, enter the per-phone token generated outside the repository.
It is retained in Android app-private preferences. The pinned development CA
currently targets `10.0.0.134:4181`; change both `INSPECTION_BASE_URL` and the
network-security domain together for another host.
