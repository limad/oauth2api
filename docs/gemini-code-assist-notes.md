# Antigravity / gemini-cli — notes sur l'accès Gemini par login Google

Notes de session (2026-08-23) documentant comment Antigravity et `gemini-cli`
donnent accès à Gemini via un simple login Google (sans clé API AI Studio ni
compte de service Vertex), et ce qui a été repris dans le provider `gemini`
de ce daemon (`src/providers/gemini.ts`).

## ✅ État au 2026-08-23 : ça marche (via le client Antigravity)

Testé en conditions réelles (compte perso `l.imad44@gmail.com`) : login
OAuth → onboarding → `generateContent` → réponse consommée par le plugin,
**tier gratuit**, bout en bout. `/admin/accounts` confirme
`totalSuccesses: 1, totalFailures: 0`.

Le chemin qui marche n'est PAS celui du client OAuth public `gemini-cli`
(voir section historique ci-dessous — Google l'a fermé pour le tier
individuel gratuit) mais celui du client **Antigravity**, avec trois pièges
qu'il a fallu lever un par un :

1. **`ideType: "ANTIGRAVITY"`** dans les métadonnées `loadCodeAssist` (au
   lieu de `"IDE_UNSPECIFIED"`) — sans ça, même avec le bon client_id,
   Google renvoie encore `UNSUPPORTED_CLIENT`.
2. **Header `User-Agent`** imitant l'app Electron réelle
   (`Antigravity/x.y.z (...) Chrome/... Electron/...`) sur les appels
   `loadCodeAssist`/`generateContent` — sans lui, `UNSUPPORTED_CLIENT`
   persiste même avec le bon `ideType`. C'est probablement le vrai signal
   que Google utilise pour distinguer un client légitime.
3. **Ids de modèle internes** — le backend Code Assist rejette les noms
   publics (`gemini-3.1-pro` → 404 "Requested entity was not found") ; il
   faut les vrais ids avec le palier de réflexion intégré
   (`gemini-3.1-pro-high`, `gemini-3-flash`, …). Voir `resolveGeminiModel`
   dans `src/upstream/gemini-translator.ts`.
4. **`thought_signature`** — sur les modèles Gemini 3.x avec thinking actif,
   tout `functionCall` rejoué en historique doit porter un
   `thoughtSignature`/`thought_signature`, sinon 400. On capture le vrai
   signature quand disponible, sinon on envoie le sentinel
   `"skip_thought_signature_validator"` (repris de
   `Draculabo/AntigravityManager`).

Client id/secret, endpoints (fallback sandbox→daily→prod), User-Agent et
mapping de modèles : tous corroborés par deux projets communautaires actifs
et populaires (`lbjlaq/Antigravity-Manager`, 30k+ ⭐ ; `Draculabo/AntigravityManager`,
2k+ ⭐) — voir Références.

## Historique — pourquoi pas le client `gemini-cli` officiel

Testé en premier (voir aussi git blame de ce fichier) : `loadCodeAssist`
avec le client OAuth officiel `gemini-cli` renvoie ceci — **plus aucun
tier gratuit disponible** :

```json
{
  "allowedTiers": [{
    "id": "standard-tier",
    "name": "Gemini Code Assist",
    "description": "Unlimited coding assistant with the most powerful Gemini models",
    "userDefinedCloudaicompanionProject": true,
    "isDefault": true
  }],
  "ineligibleTiers": [{
    "tierId": "free-tier",
    "tierName": "Gemini Code Assist for individuals",
    "reasonCode": "UNSUPPORTED_CLIENT",
    "reasonMessage": "This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google"
  }]
}
```

Autrement dit : **Google a explicitement désactivé le tier gratuit "for
individuals" pour le client OAuth public de `gemini-cli`**, et redirige vers
Antigravity comme successeur officiel — ce que confirme la section
ci-dessus. Le seul tier restant sous `gemini-cli` (`standard-tier`) exige un
projet GCP fourni par l'utilisateur (`userDefinedCloudaicompanionProject:
true`) — sans accès gratuit garanti. Le code garde `GOOGLE_CLOUD_PROJECT`/
`GOOGLE_CLOUD_PROJECT_ID` en fallback dans `resolveGeminiProject` pour ce
cas (compte Workspace, ou si Google referme aussi la voie Antigravity un
jour).

Cette fermeture peut n'être qu'une clause de migration temporaire (le
message dit "migrate to Antigravity", pas "ce n'est plus possible du
tout") — à re-tester périodiquement si Google fait marche arrière ou
propose une équivalence claire côté Antigravity.

## Le point de départ : pourquoi pas juste une clé API ?

Trois façons d'accéder à Gemini existent côté Google :

| Voie | Auth | Backend | Facturation |
|---|---|---|---|
| **AI Studio** (`geminiAssistant_Api.php` du plugin) | Clé API (`?key=...`) | `generativelanguage.googleapis.com` (API publique) | Pay-as-you-go direct |
| **Vertex AI** | Compte de service + OAuth2 machine-to-machine | `{region}-aiplatform.googleapis.com` | Crédit Google Cloud / facturation projet |
| **Code Assist** (gemini-cli, Antigravity) | OAuth2 utilisateur (login Google interactif) | `cloudcode-pa.googleapis.com/v1internal` (API interne, non publique) | Quotas/tiers gérés par Google, souvent gratuits |

Un point important découvert en creusant : passer un token OAuth utilisateur
en `Authorization: Bearer` vers l'API **publique** `generativelanguage.googleapis.com`
ne débloque **aucun accès gratuit** — cette API facture pareil quel que soit le
mode d'auth. Le vrai accès "gratuit via login perso" n'existe que via le
backend **Code Assist**, distinct de l'API publique.

## Antigravity

Antigravity est l'IDE agentique de Google (identifié dans ce fil de
conversation via interception de son trafic réseau — proxy/MITM local,
**pas** de la rétro-ingénierie de binaire). Son flow de login Google a été
observé avec :

- **Client OAuth** : `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
- **Scopes demandés** : `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`, `aicode`
- **redirect_uri** : `http://localhost:<port dynamique>/auth/callback`, flow PKCE (`code_challenge` + `S256`)

Les scopes `cclog` (logging client) et `experimentsandconfigs` (feature
flags/A-B testing) suggèrent qu'Antigravity utilise ce même token pour sa
télémétrie interne en plus de l'accès modèle — cohérent avec un produit
Google plus large que le seul accès Gemini.

⚠️ Ce client_id **n'est pas documenté publiquement** par Google (contrairement
à celui de `gemini-cli`, voir plus bas) — il a été observé, pas publié. Le
réutiliser dans un outil tiers est une zone plus grise côté ToS que de
reprendre un client officiellement open source. **Il n'a donc pas été utilisé
dans l'implémentation de ce daemon.**

**Sécurité** : la capture de trafic initiale contenait aussi les cookies de
session Google du poste (`SID`, `__Secure-1PSID`, etc.) — ces valeurs n'ont
été ni conservées ni documentées ici. Toujours exclure `accounts.google.com`
(ou au moins l'en-tête `Cookie`) d'une capture avant de la partager.

## gemini-cli — la voie retenue

`gemini-cli` ([google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli),
Apache-2.0) est l'outil CLI officiel et open source de Google. Son client
OAuth est publié en clair dans le code source, avec ce commentaire explicite :

> "It's ok to save this in git because this is an installed application...
> the client secret is obviously not treated as a secret."
> — `packages/core/src/code_assist/oauth2.ts`

Valeurs vérifiées dans leur repo (voir Références) :

```
client_id     = 681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com
client_secret = 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
scopes        = https://www.googleapis.com/auth/cloud-platform
                https://www.googleapis.com/auth/userinfo.email
                https://www.googleapis.com/auth/userinfo.profile
```

Scope plus restreint qu'Antigravity (pas de `cclog`/`experimentsandconfigs`/
`aicode`) — cohérent avec un CLI qui ne fait que de l'inférence, sans
télémétrie produit associée.

### Le backend : Code Assist, pas l'API publique

```
CODE_ASSIST_ENDPOINT     = https://cloudcode-pa.googleapis.com
CODE_ASSIST_API_VERSION  = v1internal
```
(`packages/core/src/code_assist/server.ts`)

Les appels sont RPC-style (`:generateContent`, `:streamGenerateContent?alt=sse`,
pas de `/`), et chaque requête est enveloppée dans un format propriétaire
(`CAGenerateContentRequest`, `packages/core/src/code_assist/converter.ts`) :

```ts
{
  model: string,
  project?: string,        // Code Assist project id, résolu via onboarding
  user_prompt_id?: string,
  request: {                // le contenu Gemini "classique" (contents/parts/…)
    contents: Content[],
    systemInstruction?: Content,
    tools?: ToolListUnion,
    toolConfig?: ToolConfig,
    generationConfig?: {...},
    session_id?: string,
  },
  enabled_credit_types?: string[],
}
```

### Le handshake d'onboarding (le vrai piège)

Un appel `generateContent` nu échoue sans avoir d'abord résolu un
**project id Code Assist** associé au compte. Le flow complet
(`packages/core/src/code_assist/setup.ts`, fonction `setupUser`) :

1. `loadCodeAssist` — récupère l'état du compte. S'il a déjà un
   `cloudaicompanionProject`, terminé.
2. Sinon, `onboardUser` avec le tier par défaut retourné par `loadCodeAssist`.
   **Piège** : pour le tier `free-tier`, il ne faut **surtout pas** envoyer de
   `cloudaicompanionProject` dans la requête — ça déclenche une erreur
   `Precondition Failed` côté serveur. Le tier gratuit utilise un projet
   géré par Google, assigné automatiquement.
3. `onboardUser` retourne une `LongRunningOperationResponse` — si `done` est
   faux, il faut poller `getOperation` (délai de ~5s recommandé par
   gemini-cli) jusqu'à obtenir `response.cloudaicompanionProject.id`.

Ce handshake n'a besoin d'être fait **qu'une fois par compte** — le project
id résolu est stable et peut être mis en cache/persisté.

### Streaming

`streamGenerateContent?alt=sse` renvoie des lignes `data: {...}` (pas de
champ `event:`), où chaque chunk contient les **parts incrémentales** du
candidat courant (comportement standard de l'API Gemini) — sauf les parts
`functionCall`, toujours envoyées entières en un seul chunk (pas de
streaming token-par-token des arguments, contrairement à Anthropic).

## Implémentation dans ce daemon

| Composant | Fichier |
|---|---|
| OAuth (client Antigravity, PKCE, refresh) | `src/auth/gemini/oauth.ts` |
| Handshake `loadCodeAssist`/`onboardUser` + appels `generateContent` | `src/upstream/gemini-api.ts` |
| Traduction Anthropic Messages ↔ format Gemini (requête, réponse, SSE) | `src/upstream/gemini-translator.ts` |
| Déclaration du provider | `src/providers/gemini.ts` |

Le provider déclare `nativeFormat: "anthropic-messages"` : toute la
traduction Gemini est encapsulée dans `callGeminiMessages`, qui reçoit un
body Anthropic Messages et renvoie un `Response` déjà au format Anthropic
Messages (JSON ou SSE) — aucune modification des handlers génériques
(`handlers/anthropic.ts`, `handlers/openai.ts`) n'a été nécessaire.

Le `geminiProjectId`/`geminiUserTier` résolus lors du handshake sont
persistés dans le fichier de token (`gemini_project_id`/`gemini_user_tier`,
voir `src/auth/token-storage.ts`) — résolu une seule fois au login, jamais
recalculé au refresh.

**Non couvert** (cas rares, hors scope du besoin actuel) :
- Tiers nécessitant une validation manuelle (`ValidationRequiredError` côté
  gemini-cli).
- `countTokens` (enveloppe de requête différente, non câblée).
- Cache serveur des vrais `thoughtSignature` par tool_use id (SignatureStore
  côté Draculabo/AntigravityManager) — on s'appuie sur le round-trip client
  + fallback placeholder, voir section "ça marche" ci-dessus. Suffisant en
  pratique, mais une vraie session serait plus fidèle si le placeholder
  s'avère insuffisant sur certains modèles/contextes.

`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT_ID` (lu depuis l'environnement
du process, comme gemini-cli) reste en fallback dans `resolveGeminiProject`
pour le cas où le client Antigravity serait à son tour fermé.

## Références

- [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) — repo officiel, Apache-2.0. Base du fallback `standard-tier`/`GOOGLE_CLOUD_PROJECT`.
  - `packages/core/src/code_assist/oauth2.ts` — client OAuth, scopes.
  - `packages/core/src/code_assist/server.ts` — endpoint, format des requêtes RPC, parsing SSE.
  - `packages/core/src/code_assist/converter.ts` — enveloppe `CAGenerateContentRequest`/`CaGenerateContentResponse`.
  - `packages/core/src/code_assist/setup.ts` — handshake `loadCodeAssist`/`onboardUser`.
- [lbjlaq/Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) (Rust/Tauri, 30k+ ⭐) — source du client_id/secret Antigravity, de l'astuce sandbox/daily/prod, et de la lecture directe de `cloudaicompanionProject` sans onboarding.
  - `src-tauri/src/modules/oauth.rs` — client_id/secret.
  - `src-tauri/src/proxy/project_resolver.rs` — `ideType: "ANTIGRAVITY"`, endpoint sandbox.
  - `src-tauri/src/proxy/upstream/client.rs` — fallback sandbox→daily→prod.
  - `src-tauri/src/constants.rs` — construction du User-Agent imitant l'app Electron réelle.
- [Draculabo/AntigravityManager](https://github.com/Draculabo/AntigravityManager) (TypeScript, 2k+ ⭐) — corrobore le client_id/secret ; source du mapping de modèles et du sentinel `thought_signature`.
  - `src/modules/proxy-gateway/antigravity/ModelMapping.ts` — ids de modèle réels du backend Code Assist.
  - `src/modules/proxy-gateway/antigravity/ClaudeRequestMapper.ts` — `PLACEHOLDER_SIGNATURE = "skip_thought_signature_validator"`, correspondance `functionResponse.name`.
  - `src/modules/proxy-gateway/antigravity/ClaudeResponseMapper.ts` — capture de `thoughtSignature` sur les blocs `tool_use`/`thinking`.
