# Azure AI and Container Apps — Verified Portfolio Deployment

**Evidence date: November 2026.** This is a public-safe summary of an independent synthetic-data project, not a public infrastructure release or customer production environment.

## What was verified

| System | Evidence | Limit |
| --- | --- | --- |
| Azure OpenAI | GPT-4.1 mini deployment returned **Succeeded**; API keys disabled | Not an attached hosted gateway inference engine |
| Live model test | One bounded, synthetic-only Responses API request succeeded, returning review-only investigation questions | No sensitive/customer records; not mart-connected RAG |
| Azure Container Registry | Basic registry, admin login disabled, anonymous pulls disabled; image published to authenticated registry | Private artifacts remain inaccessible to public readers |
| Image hardening | 19-file source-only application staging, non-root minimal Linux runtime and immutable registry manifest digest | Final Grype scan reported **zero findings** at that point in time |
| Azure Container Apps | Azure readback returned **Succeeded**, one ready revision and **external ingress disabled** | This is control-plane/revision evidence, not a separate inside-network HTTP smoke |
| Permissions | Dedicated Entra certificate publisher granted registry-scoped image publishing; Bicep defines user-assigned managed identity and scoped access | No claim of customer IAM or end-to-end live model RBAC test |
| Cost | Separate monthly model and hosting alert budgets, with 50/80/100% threshold notifications | Budget alerts are not hard usage/spending caps |

## Why this is meaningful

The cloud work exercised the last-mile deployment concerns often missing from AI demos:

1. **Identity:** a restricted, certificate-based publishing identity rather than disabling Entra security protections to allow device-code login.
2. **Supply chain:** source-only Docker contexts, scanned dependencies, a non-root runtime and immutable image digest rather than arbitrary `latest` images.
3. **Infrastructure:** Bicep resource configuration and strict Azure What-If review; corrected an invalid logging value and runtime-dependent role-assignment expression during deployment.
4. **Privacy:** application ingress is internal-only; synthetic records and model calls have separate explicit approval gates.
5. **Verification:** independent readback from Azure validates the resource state instead of assuming an accepted command means the deployment succeeded.

## Azure OpenAI experiment is separate from hosted inference

A bounded GPT-4.1 mini Responses request on fictional manufacturing context returned suggested inspection questions. It could not assert physical root cause, overwrite Haskell KPI results, or authorize ERP/MES changes. The Azure-hosted gateway remains configured with inference disabled.

This distinction is intentional. Connecting hosted model inference and retrieval requires separate qualification of managed identity, durable cost accounting, safe input/citation handling, network access and adversarial evaluations.

## What is intentionally private

Resource identifiers, service URLs, subscription and tenant IDs, registry login addresses, credentials, private infrastructure source, budget contact information, internal runbooks, release receipts and restricted project documents are not distributed in this repository.

The public source tree does **not** include the private Container Apps runtime image/build infrastructure; it documents the architecture and tested boundary at a high level.

## Next validation milestones

- Execute a non-public internal HTTP readiness and deterministic question/answer probe.
- Verify effective managed-identity grants and actual digest-pinned image pull on a running revision.
- Separately test a cost-bounded model call through the hosted runtime after durable accounting is qualified.
- Add customer-appropriate telemetry, data residency decisions and operational controls before any production discussion.

**Disclosure:** Independent engineering demonstration using synthetic data only. No company deployment, public production service or end-to-end hosted RAG system is claimed.
