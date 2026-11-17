# Brief : l'extension MCP Skills dans mcp-core, puis dans le broker

> **Design note, in French. Not the reference.** This brief records a proposal before it is built. The extension is specified at [skills.extensions.modelcontextprotocol.io](https://skills.extensions.modelcontextprotocol.io/specification/beta/skills) (SEP-2640, identifier `io.modelcontextprotocol/skills`).

Statut : proposition, 2026-11-17. Le correctif d'autorisation côté broker (les trois méthodes classées `mcp.resources.read`) est déjà fait, voir le CHANGELOG.

## En une phrase

Ajouter à mcp-core un mécanisme d'**extensions** générique (déclaration dans les capacités, méthodes propres, aiguillage), puis bâtir dessus l'extension Skills : un serveur publie des skills (`SKILL.md` + fichiers) avec `skills/list`, `skills/get` et, en option, `resources/directory/read` ; les fichiers passent par le `resources/read` ordinaire, avec des empreintes SHA-256.

## Ce que dit la spécification, en bref

- Capacité : `capabilities.extensions["io.modelcontextprotocol/skills"] = { directoryRead?: boolean }`. Qui la déclare **doit** implémenter `skills/list` et `skills/get`, et déclarer aussi `resources`.
- Ressources : `skill://<chemin-du-skill>/<fichier>`. Le dernier segment du chemin **est** le `name` du frontmatter. Les skills peuvent s'imbriquer.
- Entrée `Skill` : `{ uri, frontmatter, resources: SkillResource[] | "dynamic", _meta? }`, où `SkillResource = { uri, digest: "sha256:<hex>", size }`. Le tableau est **complet** (SKILL.md compris, fichiers des skills imbriqués compris).
- `frontmatter` : le YAML du SKILL.md rendu tel quel en JSON, identique au fichier. Le client le revérifie champ par champ.
- `skills/list` pagine (un skill n'est jamais coupé entre deux pages). `skills/list`, `skills/get` et `resources/directory/read` renvoient `resultType: "complete"`, `ttlMs` et `cacheScope`.
- Erreurs : `skills/get` sur un skill inconnu, `resources/directory/read` sur ce qui n'est pas un répertoire (`mimeType: "inode/directory"`), `resources/read` d'un fichier inconnu : `-32602`.
- Limites par skill : 512 fichiers, 16 Mio au total.
- Révision de base : **2026-07-28** (`server/discover`, `_meta` obligatoire sur chaque requête, résultats « cacheables »).
- Aucune notification propre aux skills. Un changement se voit par `notifications/resources/list_changed` et par des empreintes qui changent.
- Presque toute la sécurité (approbation liée au contenu, origine visible, pas d'exécution implicite, `allowed-tools` ignoré) est l'affaire de l'**hôte**, pas du serveur.

## Ce qui existe dans mcp-core 1.5.0

Relevé dans `../mcp-core` :

- **Pas d'extensions.** `McpServerCapabilities` n'a pas de champ `extensions`, `_deriveCapabilities()` (`src/server/mcp.server.ts:1282`) ne regarde que les behaviors, et `_dispatch` (`:1157`) est un `switch` figé dont le `default` répond `-32601`. Aucun point d'accroche pour une méthode nouvelle.
- **Révisions** : jusqu'à `2025-11-25` (`src/mcp.protocol.ts`). Ni `server/discover`, ni `resultType`, ni `ttlMs`.
- **Routage des ressources** : URI exactes de `getResources()` puis gabarits, mais `_matchTemplate` (`:1361`) transforme chaque `{var}` en `[^/]+`. Un gabarit `skill://x/{path}` ne couvre donc pas `skill://x/templates/a.md`.
- **Pas de pagination côté serveur** ; le client suit déjà `nextCursor` (`McpClient._listAll`).
- **Le client ne garde pas les capacités** reçues à `connect()`.
- **SHA-256** seulement via `node:crypto`, dans `src/node/`. Le reste du paquet doit rester isomorphe (navigateur compris), et le paquet n'a **aucune dépendance** d'exécution.
- Conventions : membres ajoutés **optionnels** sur les interfaces publiées ; toute méthode nouvelle passe d'abord par `MCP_SERVER_REQUEST_METHODS` et `tests/spec.coverage.test.ts` ; l'historique des fonctionnalités vit dans README et AGENTS.md (marqueurs « (1.x.0) »).

## La proposition

### Phase 1 : des extensions dans mcp-core (1.6.0)

Indépendante des skills ; c'est elle qui rend la suite propre.

1. **Types.** `extensions?: Record<string, object>` dans `McpServerCapabilities` et `McpClientCapabilities` (`src/interfaces/mcp.core.interfaces.ts`).
2. **Contrat** (`src/interfaces/mcp.extension.interfaces.ts`) :
   ```ts
   interface IMcpServerExtension {
       readonly id: string;                                  // "io.modelcontextprotocol/skills"
       settings(): Readonly<Record<string, unknown>> | undefined;   // undefined: ne pas déclarer
       readonly methods: Readonly<Record<string, McpExtensionHandler>>;
       attach?(server: IMcpExtensionHost): void;             // accès aux notifiers, au contexte de requête
       detach?(): void;
   }
   type McpExtensionHandler = (req: JsonRpcRequest, ctx: IMcpRequestContext) => Promise<JsonRpcResponse>;
   ```
3. **Builder** : `McpServerBuilder.withExtension(ext)`. Refus à `build()` si une méthode recouvre une méthode du cœur ou d'une autre extension, ou si deux extensions ont le même `id`.
4. **Serveur** : le `default` de `_dispatch` consulte la table des méthodes d'extension avant `-32601`. Une méthode n'est servie **que si l'extension se déclare** (`settings()` non `undefined`), pour qu'un client qui obéit à la capacité et un client qui l'ignore voient la même chose. `_deriveCapabilities()` ajoute `extensions[id] = settings()`.
5. **Contexte** : passer `IMcpRequestContext` aussi aux handlers d'extension (aujourd'hui les handlers de liste ne le reçoivent pas ; on en a besoin pour `_meta` et l'annulation).
6. **Client** : garder les capacités du serveur (`serverCapabilities` en lecture) et `supportsExtension(id)`. Un `request<T>(method, params, options)` public, pour qu'une extension côté client ne dépende pas d'un membre privé.
7. **Couverture** : `MCP_EXTENSION_REQUEST_METHODS: Record<extensionId, string[]>` dans `mcp.protocol.ts`, et une variante du test de couverture qui monte chaque extension livrée et vérifie qu'aucune méthode listée ne répond `-32601`.

### Phase 2 : le cœur Skills, isomorphe (1.6.0 ou 1.7.0)

Fichiers sous `src/skills/`, exportés par `.` et `./server` / `./client`.

1. **Types** (`src/interfaces/mcp.skills.interfaces.ts`) : `McpSkill`, `McpSkillResource`, `McpSkillFrontmatter`, `McpListSkillsResult`, `McpGetSkillResult`, `McpReadDirectoryResult`, et la constante `MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills"`.
2. **Source de skills**, l'abstraction que l'auteur fournit :
   ```ts
   interface IMcpSkillSource {
       listSkills(cursor: string | undefined, ctx: IMcpRequestContext): Promise<{ skills: McpSkill[]; nextCursor?: string }>;
       getSkill(uri: string, ctx: IMcpRequestContext): Promise<McpSkill | undefined>;
       readFile(uri: string, ctx: IMcpRequestContext): Promise<McpResourceContent | undefined>;
       readDirectory?(uri: string, cursor: string | undefined, ctx: IMcpRequestContext): Promise<{ resources: McpResource[]; nextCursor?: string } | undefined>;
       readonly onChanged?: IEventSource<void>;
       readonly cache?: { ttlMs: number; cacheScope: "public" | "private" };
   }
   ```
3. **`McpSkillsExtension`** (implémente `IMcpServerExtension`) : `skills/list`, `skills/get` (`-32602` si inconnu), `resources/directory/read` seulement si la source a `readDirectory` (alors `directoryRead: true`). Ajoute `resultType`, `ttlMs`, `cacheScope` à chaque résultat (champs en trop, inoffensifs pour un client 2025-11-25).
4. **Les fichiers par `resources/read`** : l'extension enregistre un behavior interne `McpSkillsBehavior` qui annonce dans `resources/list` **les seuls SKILL.md** (`mimeType: text/markdown`, `name` et `description` tirés du frontmatter), et un gabarit `skill://{+path}` (ou `skill://<préfixe>/{+path}`) qui couvre tous les fichiers et répertoires, à toute profondeur. Cela repose sur le point 4 bis.
4. **bis. `{+var}` dans les gabarits** (décidé : option C). Aujourd'hui `_matchTemplate` (`src/server/mcp.server.ts:1361`) traduit toute expression `{...}` en `[^/]+`, un seul segment. On ajoute l'expansion réservée de la RFC 6570 :
   - `{var}` : **inchangé**, `[^/]+` ;
   - `{+var}` : `.+`, au moins un caractère, `/` compris ;
   - les autres opérateurs (`{/x}`, `{?x}`, `{#x}`, `{.x}`, `{;x}`, `{&x}`) : non pris en charge, comme aujourd'hui. Un gabarit qui en contient est signalé à l'enregistrement (journal), sans refus, pour ne rien casser.

   Le changement est additif : aucun gabarit des dépôts `mcp-*` n'utilise d'opérateur à ce jour (vérifié le 2026-11-17), donc aucun comportement existant ne bouge. Au passage, on sort l'algorithme dans un helper pur et exporté, `matchUriTemplate(template, uri): Record<string, string> | undefined`, qui renvoie aussi les variables (décodées en pourcentage pour `{var}`, laissées telles quelles pour `{+var}`, comme le veut la RFC). Il sert à `resourcesRead`, `_isReadable` (donc `resources/subscribe`) et `tools/call`, et un behavior peut s'en servir pour retrouver `path` sans reparser l'URI. La précédence ne change pas : URI exactes d'abord, puis gabarits dans l'ordre d'enregistrement. Pour éviter qu'un `skill://{+path}` large n'avale les URI d'un behavior plus précis enregistré après lui, l'ordre de test des gabarits devient : le plus grand nombre de caractères littéraux d'abord, l'ordre d'enregistrement ensuite.
5. **`InMemorySkillSource`**, la source livrée par défaut :
   - construite par `await InMemorySkillSource.create([{ path: "acme/billing/refunds", files: { "SKILL.md": "...", "examples/email.md": "..." } }], options)` ;
   - empreintes par `globalThis.crypto.subtle.digest("SHA-256", bytes)`, disponible dans les navigateurs et dans Node 20+ : pas de `node:crypto`, donc isomorphe ; d'où la fabrique asynchrone ;
   - `size` sur les octets UTF-8 (ou les octets d'un blob) ;
   - répertoires déduits de l'ensemble des fichiers, servis en `inode/directory`, sans barre finale ;
   - skills imbriqués : détection des `SKILL.md` descendants, chacun publié à plat, et leurs fichiers comptés aussi dans le skill englobant ;
   - pagination par curseur opaque (décalage encodé), un skill jamais coupé ;
   - `replace(...)` pour remplacer le catalogue : émet `onChanged`, que l'extension traduit en `notifications/resources/list_changed`, plus `notifications/resources/updated` pour chaque URI dont l'empreinte a changé.
6. **Validation à la construction** (échec à la construction, pas à la première requête) :
   - le dernier segment est égal à `name` ; `name` respecte les règles Agent Skills (minuscules, chiffres, tirets, 64 caractères au plus, pas de tiret au début, à la fin ni doublé) ; `description` est présente ;
   - limites 512 fichiers / 16 Mio : refus par défaut, `allowOversize` pour passer outre ;
   - premier segment valide comme `reg-name` RFC 3986 ;
   - un skill `"dynamic"` est accepté seulement si l'auteur fournit sa propre source.
7. **Frontmatter YAML sans dépendance.** Un analyseur **strict d'un sous-ensemble** livré dans le paquet (scalaires, chaînes entre guillemets, listes, une table imbriquée comme `metadata`) qui **refuse** ce qu'il ne comprend pas, avec le nom du fichier et la ligne. Option `parseFrontmatter` pour brancher un vrai analyseur (`yaml`) chez qui en a besoin. Le frontmatter rendu est celui de l'analyseur, donc identique au fichier par construction.
8. **Client** (`McpClient`, membres optionnels sur `IMcpClient`) :
   - `listSkills()` (via `_listAll`), `getSkill(uri)`, `readDirectory(uri)` ;
   - chacune refuse localement si le serveur n'a pas déclaré l'extension (ou `directoryRead`), comme l'exige la spécification ;
   - helpers purs, exportés à part, pour les hôtes : `verifySkillFile(entry, content)` (taille puis empreinte, texte encodé UTF-8 ou blob base64 décodé), `verifySkillFrontmatter(entry, skillMdText)`, `resolveSkillReference(skillUri, relative)`. L'approbation, l'étiquetage d'origine et le cache restent à l'hôte.

### Phase 3 : depuis un répertoire, Node seulement (`./node`)

`loadSkillDirectory(dir, { prefix?, watch? })` : parcourt un dossier, trouve chaque `SKILL.md`, lit les fichiers et renvoie une `InMemorySkillSource`. Les problèmes sont listés comme dans `loadGrammarDirectory`, avec `tolerate`. Avec `watch`, un `fs.watch` temporisé appelle `replace(...)`. Ignorer les liens symboliques qui sortent du dossier.

### Phase 4 : le broker (ce dépôt)

1. **Preuve de relais** : un test bout en bout avec un provider mcp-core qui publie un skill. `skills/list`, `skills/get`, `resources/read` et `resources/directory/read` passent par `/<slot>/mcp`, refusés sans `mcp.resources.read`, autorisés avec.
2. **`_all`** : pas de skills, comme pas de ressources. À documenter dans AGENTS.md §5 et dans les guides (`broker.guides.ts`). Si on veut un jour agréger, il faudra réécrire les URI par slot et recalculer les entrées, ce qui casse la règle « origine = serveur » de la spécification : à ne pas faire sans demande réelle.
3. **`_broker` publie son propre skill** : `skill://mcp-broker/SKILL.md`, dont les six pages de `broker_guide` sont les fichiers de référence. Les pages injectent la configuration effective, donc les empreintes sont calculées au démarrage, et recalculées si la configuration change. Un hôte qui sait charger des skills apprend alors le broker sans appeler un outil.
4. **Diagnostic** : rien de neuf à prévoir. Le classement d'autorisation est déjà fait.

## Décisions à prendre

1. ~~**Routage des fichiers**~~ : **décidé le 2026-11-17, option C**, `{+var}` dans les gabarits (point 4 bis). Écartées : annoncer chaque fichier dans `resources/list` (liste de centaines d'entrées) et un `ownsUri?` ad hoc sur les behaviors (un second mécanisme de routage, alors que la RFC 6570 en fournit déjà un).
2. **YAML** : sous-ensemble strict livré (proposé, zéro dépendance) ou dépendance `yaml` obligatoire.
3. **Code d'erreur d'un fichier inconnu** : la spécification dit `-32602`, mcp-core répond `-32002` (« resource not found » des révisions 2025). Proposé : `-32602` pour les URI revendiquées par l'extension Skills, `-32002` ailleurs tant que mcp-core ne parle pas 2026-07-28.
4. **Révision 2026-07-28** : `server/discover` et le `_meta` obligatoire sont un chantier mcp-core en soi. Proposé : livrer les skills sur l'`initialize` actuel (la capacité y est déclarée) et ne pas exiger `_meta`, puis brancher `server/discover` quand mcp-core prendra cette révision.

## Ce qu'on ne fait pas

- Rien sur l'approbation, le cache disque ou l'exécution des scripts d'un skill : c'est l'hôte.
- Pas de format empaqueté : la spécification n'en définit aucun.
- Aucune dépendance aux paquets d'Anthropic : on suit le format, comme pour `.mcpb`.

## Tests

- Vecteurs de la spécification : `invoice.md` (29 octets, `sha256:61f4ea6d…88d9ee`), `purchase-order.md` (35 octets), `credit-note.md` (39 octets), texte UTF-8 terminé par un saut de ligne. Ils fixent `size` et `digest` sans ambiguïté.
- `matchUriTemplate` : `{var}` toujours limité à un segment (non-régression), `{+var}` à toute profondeur, `{+var}` vide refusé, variables extraites, précédence du gabarit le plus littéral, avertissement sur un opérateur non pris en charge.
- Aller-retour `LoopbackTransport` : déclaration de la capacité, `skills/list` paginé, `skills/get` inconnu en `-32602`, répertoires (`-32602` sur un fichier), skills imbriqués (fichiers comptés deux fois), `replace(...)` et notifications.
- Côté client : refus local sans capacité ; vérification taille puis empreinte puis frontmatter, chacune avec son cas d'échec.
- Navigateur : la passe `e2e/webmcp` existante exécute `InMemorySkillSource.create` pour prouver que `crypto.subtle` suffit.

## Livraison

| lot | paquet | contenu |
|---|---|---|
| 1 | mcp-core 1.6.0 | extensions génériques, capacités gardées côté client, `request()` public |
| 2 | mcp-core 1.6.0 ou 1.7.0 | `{+var}` et `matchUriTemplate` ; Skills : types, extension, `McpSkillsBehavior`, `InMemorySkillSource`, client et vérification |
| 3 | mcp-core, même version que le lot 2 | `loadSkillDirectory` dans `./node` |
| 4 | broker, version mineure suivante | test de relais, skill de `_broker`, documentation `_all` ; dépendance mcp-core relevée |
