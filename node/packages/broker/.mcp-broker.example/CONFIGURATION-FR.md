# Guide pédagogique du fichier `config.json`

Ce document explique le fichier [`config.json`](config.json) propriété par
propriété. Il est destiné aux développeurs qui connaissent peu OAuth, JWT ou
les modèles de permissions.

## Avant de commencer

Le vrai fichier est du JSON strict. Le JSON ne permet pas les commentaires.
N'ajoutez donc pas de lignes commençant par `//` dans `config.json`.

Dans les exemples de ce guide, les commentaires servent uniquement à
l'explication. Ils ne doivent pas être copiés tels quels dans le fichier JSON.

Quelques règles de lecture :

- `{` ouvre un objet, c'est-à-dire un ensemble de propriétés.
- `}` ferme un objet.
- `[` ouvre une liste.
- `]` ferme une liste.
- `,` sépare deux propriétés ou deux éléments d'une liste.
- Les espaces utilisés pour aligner les valeurs ne changent pas le
  comportement.
- Les chemins de fichiers relatifs sont résolus depuis le dossier
  `.mcp-broker/`.

## La carte mentale

Le fichier répond à cinq questions :

1. Où le broker écoute-t-il ?
2. Comment chiffre-t-il les connexions ?
3. Comment reconnaît-il les clients et les fournisseurs ?
4. Que peut faire chaque client, et sur quelles ressources ?
5. Quels serveurs MCP locaux ou empaquetés doit-il charger ?

Le bloc `auth` est le plus important pour la sécurité. Il se lit ainsi :

```text
Sujets JWT        Rôles et capacités        Chemins de ressources
     qui ?               quoi ?                     où ?
       \                    |                        /
        \                   |                       /
                  décision allow ou deny
```

## Vocabulaire OAuth et autorisation

| Terme | Explication simple |
|---|---|
| OAuth 2.1 | Protocole qui permet à un client de présenter un jeton au broker. Le broker ne crée pas ce jeton |
| Authorization Server | Serveur externe qui authentifie l'utilisateur et émet le jeton |
| JWT | Format courant du jeton. Il contient des informations appelées claims |
| Claim | Propriété contenue dans le JWT, par exemple `sub`, `groups` ou `client_id` |
| JWKS | Adresse publique contenant les clés utilisées pour vérifier la signature des JWT |
| Scope OAuth | Permission grossière portée par le JWT, vérifiée avant la politique détaillée |
| Sujet | Identité déduite du JWT, par exemple `user:alice` ou `group:energy-team` |
| Capacité | Action fonctionnelle stable, par exemple `mcp.tools.diagnose` |
| Rôle | Groupe réutilisable de capacités |
| Ressource | Emplacement stable dans la hiérarchie, par exemple `/enterprise/site/area/asset` |
| Assignment | Affectation d'un rôle à un sujet sur une ressource |
| Deny | Interdiction explicite, toujours prioritaire sur une autorisation |
| Slot | Nom technique utilisé pour joindre un fournisseur MCP |
| Provider | Serveur MCP qui publie ses outils, ressources ou prompts dans un slot |

## Ordre d'une décision d'autorisation

Pour chaque requête protégée, le broker suit cet ordre :

1. Il lit le bearer token dans l'en-tête HTTP `Authorization`.
2. Il vérifie la signature, l'émetteur, l'audience et l'expiration du JWT.
3. Il vérifie `requiredScopes` ou la règle `perSlotScopes` du slot.
4. Il transforme les claims JWT en sujets.
5. Il transforme l'opération MCP en capacité.
6. Il transforme le nom du slot en chemin de ressource.
7. Il cherche les rôles affectés aux sujets sur ce chemin.
8. Il applique les éventuels `denies`.
9. Un deny correspondant refuse toujours la requête.
10. Sans deny, au moins un rôle correspondant doit accorder la capacité.
11. En l'absence d'autorisation explicite, la requête est refusée.

Cette séparation est essentielle :

- les scopes OAuth sont une première barrière grossière ;
- les rôles décrivent ce qui est permis ;
- les ressources décrivent où cela est permis ;
- les sujets décrivent à qui cela est permis.

## Lignes 1 à 5 : paramètres généraux

```json
{
    "port": 3001,
    "host": "0.0.0.0",
    "locale": "fr",
    "brokerName": "broker-eu-west"
}
```

### `port`

Port TCP sur lequel le broker écoute.

- `3001` signifie que les clients utilisent par exemple
  `https://nom-du-serveur:3001`.
- La variable d'environnement `MCP_BROKER_PORT` peut remplacer cette valeur.

### `host`

Interface réseau sur laquelle le broker accepte les connexions.

- `0.0.0.0` signifie toutes les interfaces réseau de la machine.
- Pour un développement strictement local, utilisez plutôt `127.0.0.1`.
- N'exposez jamais `0.0.0.0` sur un réseau non fiable sans TLS et
  authentification.

### `locale`

Langue utilisée pour les descriptions du provider interne `_broker`.

- `fr` sélectionne le français.
- Cette valeur ne change pas les noms des capacités ni les chemins.

### `brokerName`

Nom logique affiché par les outils d'introspection du broker.

- Il aide à distinguer plusieurs brokers.
- Il n'a aucun effet sur l'autorisation.

## Lignes 7 à 11 : chemins HTTP et WebSocket

```json
"paths": {
    "provider": "/provider",
    "client": "/",
    "mcp": "/mcp"
}
```

### `paths.provider`

Préfixe WebSocket utilisé par un fournisseur qui se connecte au broker.

Exemple :

```text
wss://mcp.factory.local/provider/spoony-00452
```

Le fournisseur demande ici le slot `spoony-00452`.

### `paths.client`

Préfixe utilisé par les clients WebSocket MCP. La valeur `/` conserve les URL
historiques :

```text
wss://mcp.factory.local/spoony-00452
```

### `paths.mcp`

Suffixe du transport MCP Streamable HTTP.

Avec le slot `spoony-00452`, l'URL devient :

```text
https://mcp.factory.local/spoony-00452/mcp
```

Les chemins `providers`, `sse` et `messages` ne sont pas redéfinis dans cet
exemple. Le broker utilise donc leurs valeurs par défaut.

## Lignes 13 à 16 : TLS

```json
"tls": {
    "cert": "certs/cert.pem",
    "key": "certs/key.pem"
}
```

TLS chiffre les échanges réseau et active HTTPS/WSS.

### `tls.cert`

Chemin du certificat public au format PEM.

Dans cet exemple, le broker cherche :

```text
.mcp-broker/certs/cert.pem
```

### `tls.key`

Chemin de la clé privée associée au certificat.

Cette clé est secrète. Elle ne doit jamais être ajoutée au dépôt Git.

Le broker doit pouvoir lire les deux fichiers. Une paire certificat et clé
incorrecte empêche le démarrage en HTTPS.

## Lignes 18 à 23 : fichiers web statiques

```json
"www": {
    "open": false,
    "mounts": [
        { "urlPrefix": "/", "dir": "www" }
    ]
}
```

### `www.open`

Indique si le broker doit ouvrir automatiquement le navigateur.

- `false` convient aux serveurs, conteneurs et environnements headless.
- `true` est pratique en développement local.

### `www.mounts`

Liste des dossiers statiques servis par le broker.

### `urlPrefix`

Préfixe URL associé au dossier. Ici `/` correspond à la racine du site.

### `dir`

Dossier local contenant les fichiers web. Ici `www` correspond à :

```text
.mcp-broker/www/
```

Ce bloc ne protège pas automatiquement une interface web. Les routes MCP sont
protégées par `auth`, mais une application web statique doit aussi être conçue
pour ne pas exposer de secret.

## Lignes 25 à 35 : activation OAuth

```json
"auth": {
    "enabled": true,
    "publicBaseUrl": "https://mcp.factory.local",
    "authorizationServers": [
        "https://identity.factory.local"
    ],
    "jwks": "https://identity.factory.local/.well-known/jwks.json",
    "requiredScopes": ["mcp:call"],
    "perSlotScopes": {
        "_broker": ["broker:admin"]
    }
}
```

### `auth.enabled`

Active l'authentification OAuth des clients.

- `true` exige un bearer token valide.
- `false` conserve le mode historique sans authentification.
- Une politique détaillée n'est utile que si les clients possèdent une
  identité authentifiée.

### `auth.publicBaseUrl`

Adresse publique utilisée par les clients pour joindre le broker.

Cette valeur doit correspondre à l'adresse réellement visible par les clients,
pas forcément à l'adresse interne du processus.

Elle sert aussi à calculer l'audience attendue du JWT. Pour le slot
`spoony-00452`, l'audience attendue est :

```text
https://mcp.factory.local/spoony-00452/mcp
```

Une erreur fréquente consiste à mettre `http://localhost:3001` alors que les
clients utilisent un reverse proxy public en HTTPS.

### `auth.authorizationServers`

Liste des serveurs d'autorisation externes annoncés aux clients.

Dans cet exemple, `https://identity.factory.local` :

- authentifie les utilisateurs ou applications ;
- émet les access tokens ;
- reste extérieur au broker.

Le broker ne devient pas un fournisseur d'identité.

### `auth.jwks`

URL du document JWKS du serveur d'autorisation.

Le broker télécharge les clés publiques de ce document pour vérifier la
signature des JWT. Une clé publique permet de vérifier un jeton, mais pas d'en
créer un.

N'utilisez pas ici une clé privée ou un secret client.

### `auth.requiredScopes`

Scopes OAuth exigés par défaut pour atteindre un slot.

```json
["mcp:call"]
```

signifie que le JWT doit contenir le scope `mcp:call`.

Ce scope ne suffit pas à lui seul lorsque la politique hiérarchique est active.
Il ouvre seulement la première barrière. Les rôles, ressources et denies sont
ensuite évalués.

### `auth.perSlotScopes`

Remplace `requiredScopes` pour certains slots.

```json
"_broker": ["broker:admin"]
```

signifie que le slot interne `_broker` exige `broker:admin` à la place de
`mcp:call`.

Cette règle protège l'accès réseau à `_broker`. La politique hiérarchique
applique ensuite la capacité `broker.providers.read` sur la ressource réservée
`/_system/broker`.

Le fichier d'exemple ne contient volontairement aucune affectation sur
`/_system/broker`. Par défaut, personne ne peut donc utiliser les outils de
`_broker`, même avec le scope `broker:admin`.

Pour accorder cet accès, ajoutez par exemple :

```json
{
    "id": "broker-administrators",
    "subject": "group:broker-administrators",
    "role": "administrator",
    "resource": "/_system/broker"
}
```

Le JWT devra alors posséder à la fois le scope `broker:admin` et le groupe
`broker-administrators`.

## Lignes 36 à 40 : claims JWT transformés en sujets

```json
"subjectMapping": {
    "userClaim": "sub",
    "groupClaims": ["groups"],
    "clientClaim": "client_id"
}
```

Le broker ne fait confiance qu'aux claims d'un JWT déjà validé.

### `userClaim`

Nom du claim contenant l'identifiant utilisateur.

Avec :

```json
{ "sub": "alice" }
```

le broker produit le sujet :

```text
user:alice
```

### `groupClaims`

Claims contenant les groupes de l'utilisateur.

Avec :

```json
{ "groups": ["maintenance-area-a", "employees"] }
```

le broker produit :

```text
group:maintenance-area-a
group:employees
```

Le claim peut être une chaîne unique ou une liste de chaînes. Un type incorrect
fait échouer l'autorisation de manière sûre.

### `clientClaim`

Claim contenant l'identifiant de l'application cliente.

Avec :

```json
{ "client_id": "local-ai-assistant" }
```

le broker produit :

```text
client:local-ai-assistant
```

Un même appel peut donc posséder plusieurs identités en même temps, par exemple
un utilisateur, deux groupes et une application cliente.

## Lignes 41 à 64 : rôles et capacités

Un rôle répond uniquement à la question « que peut-on faire ? ». Il ne contient
jamais de chemin de ressource.

### Rôle `viewer`

```json
"viewer": {
    "capabilities": [
        "mcp.resources.read",
        "mcp.tools.list",
        "mcp.prompts.read"
    ]
}
```

Ce rôle permet :

- `mcp.resources.read` : lister et lire les ressources MCP ;
- `mcp.tools.list` : voir le catalogue des outils ;
- `mcp.prompts.read` : lister et lire les prompts.

Il ne permet pas d'appeler un outil.

### Rôle `maintenance`

```json
"maintenance": {
    "inherits": ["viewer"],
    "capabilities": [
        "mcp.tools.call",
        "mcp.tools.diagnose",
        "mcp.tools.configure-analysis"
    ]
}
```

`inherits: ["viewer"]` signifie que `maintenance` récupère aussi toutes les
capacités de `viewer`.

Ses capacités supplémentaires sont :

- `mcp.tools.call` : appeler un outil sans mapping plus précis ;
- `mcp.tools.diagnose` : exécuter un diagnostic ;
- `mcp.tools.configure-analysis` : modifier une configuration d'analyse.

### Rôle `operator`

```json
"operator": {
    "inherits": ["viewer"],
    "capabilities": ["mcp.tools.operate"]
}
```

Ce rôle voit les ressources, outils et prompts grâce à `viewer`, puis peut
effectuer des opérations classées `mcp.tools.operate`.

### Rôle `administrator`

```json
"administrator": {
    "capabilities": ["*"]
}
```

`*` signifie toutes les capacités, mais uniquement sur les ressources couvertes
par une affectation.

Déclarer un rôle ne l'accorde à personne. Dans le fichier d'exemple, aucune
affectation n'utilise `administrator`. Personne n'est donc administrateur par
ce seul bloc.

## Lignes 65 à 78 : affectations

Une affectation répond à la phrase :

```text
Ce sujet reçoit ce rôle sur cette ressource.
```

### Affectation `maintenance-area-a`

```json
{
    "id": "maintenance-area-a",
    "subject": "group:maintenance-area-a",
    "role": "maintenance",
    "resource": "/enterprise-a/site-paris/area-a/**"
}
```

#### `id`

Identifiant unique utilisé dans les validations et journaux d'audit.

#### `subject`

Sujet auquel le rôle est accordé. Ici, tous les JWT contenant le groupe
`maintenance-area-a`.

#### `role`

Nom exact d'un rôle déclaré dans le bloc `roles`.

#### `resource`

Sous-arbre industriel sur lequel le rôle est valable.

Le suffixe `/**` signifie :

- la ressource `/enterprise-a/site-paris/area-a` elle-même ;
- tous ses descendants, quel que soit leur nombre de niveaux.

Un nouveau fournisseur ajouté plus tard sous cette zone est automatiquement
couvert par l'affectation.

### Affectation `energy-team`

```json
{
    "id": "energy-team",
    "subject": "group:energy-team",
    "role": "viewer",
    "resource": "/enterprise-a/site-paris/**"
}
```

Le groupe `energy-team` peut voir les ressources, outils et prompts de tout le
site Paris, sans pouvoir appeler les outils.

### Signification des wildcards

| Forme | Signification |
|---|---|
| `/enterprise/site/asset` | Ce chemin exact uniquement |
| `/enterprise/site/*` | Un seul niveau directement sous le site |
| `/enterprise/site/**` | Le site et tous ses descendants |

Les expressions régulières ne sont pas acceptées.

## Lignes 79 à 89 : interdiction explicite

```json
"denies": [
    {
        "id": "protect-critical-furnace",
        "subject": "group:maintenance-area-a",
        "capabilities": [
            "mcp.tools.configure-analysis",
            "mcp.tools.operate"
        ],
        "resource": "/enterprise-a/site-paris/area-a/line-2/cell-4/critical-furnace"
    }
]
```

Cette règle interdit au groupe de maintenance :

- de modifier la configuration d'analyse ;
- d'exécuter une opération ;
- uniquement sur le four critique indiqué.

Le groupe conserve ses autres permissions sur le reste de `area-a`.

Un deny correspondant est toujours prioritaire sur une affectation allow,
quelle que soit la position des règles dans le fichier.

Utilisez `"capabilities": ["*"]` pour interdire toute capacité sur une
ressource précise.

## Lignes 90 à 93 : noms techniques et ressources stables

```json
"slotResources": {
    "spoony-00452": "/enterprise-a/site-paris/area-a/line-3/cell-2/motor-7",
    "site-energy": "/enterprise-a/site-paris"
}
```

La clé de gauche est le nom technique du slot. La valeur de droite est son
identité stable dans la hiérarchie.

### `spoony-00452`

Un client utilise le slot technique :

```text
/spoony-00452/mcp
```

mais le moteur de politique l'évalue comme :

```text
/enterprise-a/site-paris/area-a/line-3/cell-2/motor-7
```

Le fournisseur peut se reconnecter ou changer d'adresse IP sans changer cette
identité.

### `site-energy`

Ce slot représente le site Paris lui-même. Une ressource n'est pas obligée
d'être une feuille comme un moteur.

Un slot non déclaré est normalement converti en `/<nom-du-slot>`. Pour un
environnement industriel, il est préférable de déclarer explicitement les
mappings afin de conserver des identités stables.

## Lignes 94 à 99 : classification globale des outils

```json
"toolCapabilities": {
    "get_electrical_state": "mcp.resources.read",
    "diagnose_motor": "mcp.tools.diagnose",
    "reset_baseline": "mcp.tools.configure-analysis",
    "start_motor": "mcp.tools.operate"
}
```

Le broker ne devine jamais une permission à partir du nom d'un outil. Ce bloc
associe explicitement chaque outil à une capacité.

| Outil | Capacité exigée |
|---|---|
| `get_electrical_state` | Lecture de ressource |
| `diagnose_motor` | Diagnostic |
| `reset_baseline` | Modification de la configuration d'analyse |
| `start_motor` | Opération sur l'équipement |

Si un outil n'est présent dans aucun mapping, le broker utilise la capacité
générique `mcp.tools.call`.

Cette valeur par défaut explique pourquoi le rôle `maintenance` contient aussi
`mcp.tools.call`.

## Lignes 100 à 104 : classification spécifique à une zone

```json
"providerToolCapabilities": {
    "/enterprise-a/site-paris/area-a/**": {
        "start_motor": "mcp.tools.operate"
    }
}
```

Ce bloc permet de changer la classification d'un outil pour une ressource ou un
sous-arbre précis.

Ordre de résolution :

1. mapping spécifique à la ressource dans `providerToolCapabilities` ;
2. mapping global dans `toolCapabilities` ;
3. capacité générique `mcp.tools.call`.

Dans cet exemple, la valeur spécifique de `start_motor` est identique à la
valeur globale. Cette redondance est volontairement pédagogique. Dans un vrai
déploiement, ce bloc est surtout utile si le même nom d'outil n'a pas le même
niveau de risque selon le fournisseur ou la zone.

## Lignes 105 à 107 : audit

```json
"audit": {
    "logAllowed": false
}
```

Les refus sont toujours journalisés.

`logAllowed: false` signifie que les décisions autorisées ne sont pas
journalisées. C'est la valeur recommandée pour éviter un volume de logs trop
important.

Passez temporairement à `true` pour comprendre une politique ou diagnostiquer
un problème. Les journaux contiennent la décision et les identifiants de
politique, jamais le bearer token ni le secret fournisseur.

## Ligne 108 : secret partagé des fournisseurs

```json
"providerSecret": "change-me"
```

Ce secret authentifie les serveurs MCP qui se connectent à `/provider/<slot>`
ou `/providers`.

Il est indépendant des bearer tokens des clients.

La valeur `change-me` est uniquement un placeholder. En production :

- générez une valeur longue et aléatoire ;
- fournissez-la de préférence avec
  `MCP_BROKER_PROVIDER_SECRET` ;
- ne la placez pas dans Git ;
- ne la partagez pas avec les clients MCP.

Le secret partagé conserve la compatibilité historique et permet tous les
chemins de ressources. Pour limiter chaque appareil à son propre sous-arbre,
utilisez un `IProviderAuthenticator` personnalisé qui renvoie un
`IProviderPrincipal.allowedResources`.

## Lignes 111 à 117 : serveur MCP local lancé par le broker

```json
"stdioUpstreams": [
    {
        "name": "fs",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    }
]
```

### `name`

Nom du slot exposé par le broker. Le client utilise :

```text
/fs/mcp
```

### `command`

Programme lancé par le broker. Ici, `npx`.

### `args`

Arguments transmis au programme :

- `-y` accepte automatiquement l'installation demandée par `npx` ;
- `@modelcontextprotocol/server-filesystem` est le paquet lancé ;
- `/data` est le dossier accessible au serveur.

Accorder un accès au filesystem est sensible. Limitez `/data` au strict
nécessaire.

Ajoutez `"aggregate": true` si ce provider doit aussi apparaître dans `_all`.
Sans cette propriété, cet upstream stdio reste accessible par son slot direct.

## Lignes 119 à 128 : bundle MCP local signé

```json
"mcpbBundles": [
    {
        "name": "weather",
        "path": "bundles/weather.mcpb",
        "publicKey": "bundles/mcpb-signing.pub.pem",
        "signature": "bundles/weather.mcpb.sig",
        "userConfig": { "apiKey": "your-key-here" },
        "aggregate": true
    }
]
```

### `name`

Nom du slot exposé, ici `weather`.

### `path`

Chemin du bundle `.mcpb`.

### `publicKey`

Clé publique utilisée pour vérifier que le bundle a été signé par une source
de confiance.

### `signature`

Fichier de signature détachée correspondant au bundle.

Le broker refuse de lancer le bundle si la signature est absente ou invalide.

### `userConfig`

Valeurs injectées dans la configuration déclarée par le bundle.

`apiKey` est un secret d'exemple. Ne conservez pas une vraie clé API dans une
version publique ou partagée de ce fichier.

### `aggregate`

`true` ajoute le provider `weather` au slot agrégé `_all`.

Même dans `_all`, la visibilité et les appels restent filtrés par la politique
d'autorisation.

## Exemple de décision complète

Supposons un JWT validé contenant :

```json
{
    "sub": "alice",
    "groups": ["maintenance-area-a"],
    "client_id": "local-ai-assistant",
    "scope": "mcp:call"
}
```

Alice appelle :

```text
outil : diagnose_motor
slot  : spoony-00452
```

Le broker calcule :

1. Le scope `mcp:call` satisfait la barrière OAuth.
2. Le claim `groups` produit `group:maintenance-area-a`.
3. `diagnose_motor` produit la capacité `mcp.tools.diagnose`.
4. `spoony-00452` produit la ressource
   `/enterprise-a/site-paris/area-a/line-3/cell-2/motor-7`.
5. L'affectation `maintenance-area-a` correspond au sujet et à la ressource.
6. Le rôle `maintenance` contient `mcp.tools.diagnose`.
7. Aucun deny ne correspond à ce moteur.
8. La décision finale est allow.

Si Alice tente `start_motor` sur le four critique :

1. `start_motor` produit `mcp.tools.operate`.
2. Le deny `protect-critical-furnace` correspond à la ressource.
3. Le deny est prioritaire.
4. La décision finale est deny.

## Checklist avant un déploiement

- Remplacer tous les domaines `.local` par les adresses réelles.
- Vérifier que `publicBaseUrl` est exactement l'adresse publique du broker.
- Vérifier que les JWT utilisent cette ressource dans leur audience.
- Vérifier l'URL JWKS et l'émetteur attendu.
- Ne jamais conserver `change-me`.
- Ne jamais publier la clé TLS privée.
- Ne jamais publier les clés API de `userConfig`.
- Utiliser `127.0.0.1` au lieu de `0.0.0.0` si aucun accès réseau n'est requis.
- Tester chaque rôle avec un compte représentatif.
- Tester les denies sur les actifs critiques.
- Vérifier que `_all` ne révèle pas les providers non autorisés.
- Laisser `audit.logAllowed` à `false` après le diagnostic.
- Redémarrer le broker après toute modification, car les politiques sont
  chargées une seule fois au démarrage.

## Pour aller plus loin

- [Référence complète de configuration](../docs/config.md)
- [Guide OAuth du broker](../../docs/authorization.md)
- [Autorisation hiérarchique](../../docs/hierarchical-authorization.md)
