# Livynq Home Assistant add-on

Files for a Home Assistant add-on repository:

```
repository.yaml
livynq/
  config.yaml  build.yaml  Dockerfile  run.sh  DOCS.md
```

**Local install (no repository needed):** copy `livynq/` to the `/addons/livynq` folder of your
Home Assistant (Samba / SSH add-on), then Settings → Add-ons → Add-on store → ⋮ → Check for updates;
"Livynq" appears under *Local add-ons*.

**Repository:** publish this directory as the root of a Git repository and add its URL to the add-on
store. The image downloads the Livynq release binary for the version in `config.yaml`, so a GitHub
release with `livynq-linux-x64.gz` and `livynq-linux-arm64.gz` must exist first.
