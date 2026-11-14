# Deployment configuration boundary

Instance identity belongs in an external JSON profile, not in operator source. Start from `deployment-profile.example.json`; replace the example values, review the complete file and pin its SHA-256. The profile contains addresses, platform/model identifiers, account names and paths only. Passwords, model credentials, SSH private keys and control keys remain separate restricted files.

Set `AITESTHUB_DEPLOYMENT_PROFILE_FILE` to the absolute external path and `AITESTHUB_DEPLOYMENT_PROFILE_SHA256` to its reviewed digest. The reader rejects files inside the code tree, symbolic links, changed bytes, unsupported fields and unsafe directories. Nothing silently selects a host or a platform.

The versioned 33-to-36 operator still requires its original explicit authorization flag, exact runtime/build manifest, signed backup/permit, stopped roles, drained work and original proof. Its signed target now also includes the deployment-profile digest. Configuration does not grant authority to run it, replace keys, recreate anchors or replay tasks.

For staging, `pack-image36.mjs` packages an already verified image. `pack-operator36.mjs` reads the profile and creates a self-contained code archive plus a separate private plan. `upload-stage36.mjs` additionally requires `AITESTHUB_DEPLOYMENT_PLAN_SHA256`, and an external SSH binding specified by `AITESTHUB_SSH_BINDING_FILE` / `AITESTHUB_SSH_BINDING_SHA256`. Host keys remain pinned and transfers are not automatically retried. The generic `stage-runtime.py` takes an external plan filename and digest; it does not embed an instance in Python source.

These tools retain the narrow 33-to-36 upgrade and staging preconditions. They are not a universal upgrade runner. Completed releases and their original signed operators/proofs remain immutable; use the preserved version to inspect an old operation.
