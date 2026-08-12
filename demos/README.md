# Demo source

This directory stores optional runnable source that accompanies a Cookbook article. Standalone Demo submissions are not accepted: `demos/<slug>/` must match one owner article with the same slug, and that article must link the Demo's GitHub URL.

Read the authoritative [Demo Contract](../docs/demo-contract.md) before contributing.

```text
demos/<slug>/
├── README.md
├── src/ or the project's native source layout
├── .env.example                         optional placeholders only
├── dependency manifests and lockfiles   optional
├── fixtures/                            optional small public data
└── THIRD_PARTY_NOTICES.md               required when applicable
```

Every Demo README includes `Corresponding article`, `Prerequisites`, `Setup`, `Run`, `Verification`, `Cleanup`, and `Cost and safety` sections, or their Chinese equivalents defined by the contract.

Repository automation statically inspects Demo files but never installs, builds, tests, or runs them. Maintainers review all instructions and source manually. Demo source remains on GitHub and is excluded from Cookbook publication artifacts.
