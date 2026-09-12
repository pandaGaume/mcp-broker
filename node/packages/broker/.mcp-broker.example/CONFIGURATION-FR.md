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

Chaque section ci-dessous porte le nom de la clé qu'elle explique, et non un
numéro de ligne, pour que le guide reste juste quand le fichier d'exemple
grossit.

Une chose à savoir avant tout le reste : **le modèle est livré avec
`auth.enabled: false`**. Une copie fraîche démarre et répond à tous les clients,
ce qui est exactement ce qu'il faut le temps de prendre ses marques. Tout le
bloc `auth` reste présent, comme référence pour le jour où vous l'activerez.
Lisez [`docs/authorization.md`](../../../../docs/authorization.md) avant de le
faire.

## La carte mentale

Le fichier répond à six questions :

1. Où le broker écoute-t-il ?
2. Comment chiffre-t-il les connexions ?
3. Quelles pages web, s'il y en a, ont le droit de l'appeler ?
4. Comment reconnaît-il les clients et les fournisseurs ?
5. Que peut faire chaque client, et sur quelles ressources ?
6. Quels serveurs MCP locaux ou empaquetés doit-il charger ?

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

## Paramètres généraux

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
- **Utilisable seulement par l'API programmatique aujourd'hui.** Le tunnel
  l'honore, mais le broker en ligne de commande n'a pas encore de moyen de le
  transmettre : le renseigner ici ne change donc rien. Passez par
  `IWsTunnelOptions.brokerName` si vous en avez besoin dès maintenant.

## Origines navigateur autorisées

```json
"allowedOrigins": ["https://app.factory.local", "https://mcp.factory.local"]
```

La liste des origines de pages web autorisées à appeler ce broker en HTTP. Elle
est vérifiée sur `/<slot>/mcp`, `/<slot>/sse` et `/<slot>/messages`.

Trois règles à retenir, parce que chacune surprend quelqu'un :

1. **Absent veut dire fermé.** Sans `allowedOrigins`, toute requête portant un
   en-tête `Origin` est refusée avec un `403`. C'est volontaire : sans ce
   contrôle, n'importe quelle page ouverte dans le navigateur de l'utilisateur
   pourrait piloter votre broker.
2. **Une requête sans en-tête `Origin` passe toujours.** Claude Desktop,
   l'Inspector MCP et tous les SDK côté serveur n'en envoient pas : c'est
   pourquoi tout semble parfait jusqu'au premier navigateur.
3. **Être servie par ce broker n'exempte de rien.** Une page chargée depuis le
   montage `www` reste une origine navigateur et doit figurer dans la liste.

La comparaison est littérale : le schéma et le port font partie de la valeur.
`https://app.factory.local` ne correspond ni à `http://app.factory.local` ni à
`https://app.factory.local:8443`, et une barre oblique finale ne correspond
jamais. Ce modèle définit `tls.cert`/`tls.key`, le broker parle donc HTTPS et les
entrées utilisent `https://`. Retirez le bloc TLS et elles doivent devenir
`http://...:3001`.

Une expression régulière remplace la liste quand les origines ne sont pas
connues à l'avance :

```json
"allowedOrigins": { "pattern": "^https://[a-z0-9-]+\\.factory\\.local$" }
```

`MCP_BROKER_ALLOWED_ORIGINS` remplace le fichier par une liste séparée par des
virgules. Cette variable ne peut pas porter la forme `pattern` : une expression
régulière ne survit pas à un découpage sur les virgules.

## Chemins HTTP et WebSocket

```json
"paths": {
    "provider":  "/provider",
    "providers": "/providers",
    "client":    "/",
    "mcp":       "/mcp",
    "sse":       "/sse",
    "messages":  "/messages"
}
```

Les six clés sont honorées, et chacune est aussi réglable par une variable
d'environnement, qui l'emporte : `MCP_BROKER_PROVIDER_PATH`,
`MCP_BROKER_PROVIDERS_PATH`, `MCP_BROKER_CLIENT_PATH`, `MCP_BROKER_MCP_PATH`,
`MCP_BROKER_SSE_PATH`, `MCP_BROKER_MESSAGES_PATH`.

En changer un déplace le point d'entrée pour tout le monde : le SDK fournisseur,
les clients, et les URL affichées au démarrage. N'y touchez pas sans raison.

### `paths.provider`

Préfixe WebSocket utilisé par un fournisseur qui se connecte au broker.

Exemple :

```text
wss://mcp.factory.local/provider/spoony-00452
```

Le fournisseur demande ici le slot `spoony-00452`. La socket transporte des
trames JSON-RPC nues, un fournisseur par socket. Dans
`@cyanmycelium/mcp-broker-provider`, c'est `DirectTransport`.

### `paths.providers`

Chemin WebSocket exact (aucun nom de slot n'y est ajouté) utilisé par un
fournisseur qui porte plusieurs slots sur une seule socket, en enveloppant
chaque trame dans une enveloppe qui nomme le slot. Dans
`@cyanmycelium/mcp-broker-provider`, c'est `MultiplexTransport`.

```text
wss://mcp.factory.local/providers
```

`paths.provider` et `paths.providers` diffèrent d'une lettre et ne sont **pas
interchangeables** : ce qui les sépare est le format des trames, pas seulement
l'URL. Brancher un `MultiplexTransport` sur `/provider/<nom>`, ou un
`DirectTransport` sur `/providers`, est l'erreur d'intégration la plus fréquente.
Le broker nomme désormais l'incohérence et refuse la socket au lieu de rester
muet, mais autant faire juste du premier coup :

| Point d'entrée      | Trames             | Transport            |
|---------------------|--------------------|----------------------|
| `/provider/<nom>`   | JSON-RPC nu        | `DirectTransport`    |
| `/providers`        | enveloppes         | `MultiplexTransport` |

`/providers/<nom>` n'est ni l'un ni l'autre : c'est compris comme une connexion
*cliente* sur un slot littéralement nommé `providers/<nom>`.

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

C'est le transport à privilégier. Les deux suivants sont l'ancien couple.

### `paths.sse`

Suffixe du flux SSE historique, ouvert en `GET`. Le broker y répond par un
événement `endpoint` qui porte l'URL où poster.

```text
https://mcp.factory.local/spoony-00452/sse
```

### `paths.messages`

Suffixe où le client SSE historique `POST`e ses requêtes JSON-RPC, en paire avec
le flux ci-dessus.

```text
https://mcp.factory.local/spoony-00452/messages
```

Ces deux points d'entrée historiques sont soumis au même contrôle
`allowedOrigins` que `/<slot>/mcp`.

## Surveillance des fournisseurs

```json
"providerHeartbeatIntervalMs": 30000,
"providerRequestTimeoutMs": 60000,
"providerTakeover": "liveness"
```

Trois clés facultatives. Les valeurs montrées sont celles par défaut : vous
pouvez supprimer le bloc entier. Elles sont explicitées ici parce que, quand un
fournisseur se comporte mal, ce sont ces trois-là qu'on règle.

### `providerHeartbeatIntervalMs`

Intervalle entre deux pings envoyés à chaque socket fournisseur. Un fournisseur
qui rate un intervalle complet est déconnecté et son slot libéré. `0` désactive
le mécanisme. Aussi `MCP_BROKER_PROVIDER_HEARTBEAT_MS`.

Sans lui, une socket dont le pair a disparu sans fermer proprement (onglet tué,
portable mis en veille, VPN coupé) reste ouverte pour le système pendant environ
deux heures, durant lesquelles le broker annonce le slot comme connecté et
refuse toutes les tentatives de reconnexion.

Soyons honnêtes sur ce que cela prouve : un pong est renvoyé par la pile réseau
du pair, pas par le JavaScript de la page. Cela détecte un processus, une machine
ou un chemin réseau mort, pas un fournisseur connecté qui ne répond simplement
pas. Pour cela, voir la clé suivante.

### `providerRequestTimeoutMs`

Délai au bout duquel le broker abandonne l'attente d'une réponse du fournisseur
et renvoie une erreur JSON-RPC nommant le slot. `0` désactive le délai. Aussi
`MCP_BROKER_PROVIDER_REQUEST_TIMEOUT_MS`.

Augmentez-le si vous hébergez des outils réellement longs. Diminuez-le si vous
préférez une erreur à un client qui attend indéfiniment, car c'est l'alternative :
un onglet mis en veille par le navigateur est un fournisseur connecté qui ne
répond à rien.

### `providerTakeover`

Ce qui se passe quand un fournisseur se connecte à un slot déjà tenu par une
autre socket.

- `"reject"` : le tenant garde toujours le slot.
- `"liveness"` (défaut) : le tenant ne le garde que tant qu'il répond aux pings.
- `"always"` : le nouveau venu l'emporte, mais uniquement si l'authentification
  des fournisseurs est configurée et qu'il s'est authentifié sous le même
  principal que le tenant. Sans authentification des fournisseurs, le broker
  retombe sur `"liveness"` et le dit, car une reprise inconditionnelle
  permettrait à quiconque atteint l'URL d'évincer le vrai fournisseur.

Aussi `MCP_BROKER_PROVIDER_TAKEOVER`.

## TLS

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

## Fichiers web statiques

```json
"www": {
    "open": false,
    "mounts": [
        { "urlPrefix": "/", "dir": "www" }
    ]
}
```

### `www.open`

Indique si le broker doit ouvrir automatiquement le navigateur au démarrage.

- `false` (ou absent) convient aux serveurs, conteneurs et environnements
  headless.
- `true` ouvre la racine du broker, `https://localhost:3001/`.
- Une chaîne ouvre une page précise : `"/app/index.html"`, ou une URL absolue
  sur l'origine de ce broker.

Une URL sur une autre origine est refusée avec un message sur la sortie
d'erreur, comme toute autre chaîne : une valeur transmise telle quelle à la
commande « ouvrir ceci » du système peut lancer un fichier local ou une
application enregistrée, et rien dans le démarrage d'un broker n'exige de visiter
un autre hôte. Ouvrez-la vous-même.

Le navigateur ne s'ouvre que si une entrée `www.mounts` couvre réellement le
chemin résolu. Sinon, le broker indique quels préfixes sont montés au lieu de
lancer un navigateur sur un `404`.

`MCP_BROKER_OPEN` accepte les mêmes valeurs (`"1"` pour la racine).

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

## Activation OAuth

```json
"auth": {
    "enabled": false,
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

Active l'authentification OAuth des clients. **Ce modèle la livre désactivée.**

- `false` (la valeur livrée) conserve le mode historique sans authentification :
  tous les clients atteignent tous les slots. À utiliser sur un réseau de
  confiance, et le temps de faire fonctionner le reste.
- `true` exige un bearer token valide sur chaque requête cliente. Le reste du
  bloc doit alors décrire un vrai serveur d'autorisation : avec `enabled: true`
  et les valeurs d'exemple `identity.factory.local` encore en place, le broker
  répond `401` à tous les clients avec un défi pointant vers un hôte qui
  n'existe pas, ce qui est une façon déroutante d'occuper un après-midi.
- Une politique détaillée n'est utile que si les clients possèdent une
  identité authentifiée.

Tout ce qui suit (`roles`, `assignments`, `denies`, `slotResources`,
`toolCapabilities`) est inerte tant que `enabled` vaut `false`. C'est conservé
dans le modèle comme exemple travaillé, pas parce que cela agit.

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

## Claims JWT transformés en sujets

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

## Rôles et capacités

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

## Affectations

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

## Interdiction explicite

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

## Noms techniques et ressources stables

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

## Classification globale des outils

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

## Classification spécifique à une zone

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

## Audit

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

## Secret partagé des fournisseurs

```json
"providerSecret": "change-me"
```

**Volontairement absent du modèle livré.** Ajoutez la clé dans `auth` pour
activer l'authentification des fournisseurs.

Ce secret authentifie les serveurs MCP qui se connectent à `/provider/<slot>`
ou `/providers`. Chaque fournisseur doit alors le présenter dans
`X-Provider-Token` ou `Authorization: Bearer`, faute de quoi il est refusé dès la
poignée de main WebSocket.

Il est indépendant des bearer tokens des clients, et surtout il n'est **pas**
gouverné par `auth.enabled` : dès qu'il est défini, l'authentification des
fournisseurs est active, même avec OAuth désactivé. C'est pourquoi le modèle ne
le livre pas. Laissé en place avec sa valeur d'exemple, il refuserait tous les
fournisseurs sur un broker que le lecteur croit grand ouvert.

Une conséquence à anticiper : le constructeur `WebSocket` du navigateur ne peut
pas poser d'en-têtes de requête, donc un fournisseur hébergé dans une page web ne
peut pas présenter ce secret du tout. Avec `providerSecret` défini, les
fournisseurs navigateur sont exclus ; il leur faut l'authentification
fournisseur désactivée, ou un reverse proxy authentifiant en amont.

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

## Serveur MCP local lancé par le broker

```json
"stdioUpstreams": [
    {
        "name":      "fs",
        "command":   "npx",
        "args":      ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
        "aggregate": true
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

### `aggregate`

`true` fait entrer ce fournisseur dans le slot réservé `_all`, en plus de son
propre `/fs/mcp`. Sans cette propriété, cet upstream stdio reste accessible par
son slot direct uniquement.

Notez l'asymétrie : les entrées `stdioUpstreams` ne rejoignent **pas** `_all` par
défaut, alors que les entrées `mcpServers` et `mcpbBundles` le font. Renseignez
la clé explicitement dans les deux cas et vous n'aurez jamais à vous en
souvenir.

## Passerelle stdio vers un hôte MCP

Absent de `config.json`, mais c'est la raison pour laquelle on règle `aggregate`
en premier lieu. Un second fichier de ce dossier,
`config.stdio-bridge.json`, ajoute une clé :

```json
"stdioProvider": "_all"
```

Avec elle, le broker se comporte aussi comme un serveur MCP stdio : il lit du
JSON-RPC sur son entrée standard et écrit les réponses sur sa sortie standard,
reliant un hôte comme Claude Desktop à un slot. Pointez la configuration de
l'hôte sur ce fichier :

```json
{
    "command": "npx",
    "args": ["-y", "@cyanmycelium/mcp-broker"],
    "env": { "MCP_BROKER_CONFIG": "/chemin/absolu/.mcp-broker/config.stdio-bridge.json" }
}
```

Deux points à ne pas manquer.

- **Visez `_all`, pas un vrai slot.** `_all` existe dès le démarrage et répond
  lui-même à la poignée de main, donc l'hôte se connecte même si aucun
  fournisseur n'est encore arrivé, et il annonce les nouveaux outils au fur et à
  mesure. Pointé sur un vrai slot, l'hôte démarre avant le fournisseur, reçoit
  « non connecté » dès son premier message et abandonne. Pour un fournisseur
  hébergé dans une page web, c'est garanti : la page ne peut pas être ouverte
  avant le lancement de l'hôte. `_broker` répond toujours lui aussi, mais
  n'offrira jamais que les cinq outils d'introspection. Le broker prévient au
  démarrage quand `stdioProvider` nomme un slot qu'il n'héberge pas.
- **Gardez cela dans un fichier séparé.** Avec `stdioProvider`, la sortie
  standard appartient au flux JSON-RPC et toutes les traces passent sur la sortie
  d'erreur : un broker lancé ainsi dans un terminal a l'air de ne rien faire.

`MCP_BROKER_STDIO_PROVIDER` règle la même chose depuis l'environnement.

## Bundle MCP local signé

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

- Passer `auth.enabled` à `true`. Le modèle le livre désactivé pour qu'une copie
  fraîche démarre ; le laisser ainsi en production signifie que tous les clients
  atteignent tous les slots.
- Remplacer tous les domaines `.local` par les adresses réelles.
- Vérifier que `publicBaseUrl` est exactement l'adresse publique du broker.
- Vérifier que les JWT utilisent cette ressource dans leur audience.
- Vérifier l'URL JWKS et l'émetteur attendu.
- Si vous ajoutez `providerSecret`, ne jamais conserver `change-me`.
- Ne jamais publier la clé TLS privée.
- Ne jamais publier les clés API de `userConfig`.
- Utiliser `127.0.0.1` au lieu de `0.0.0.0` si aucun accès réseau n'est requis.
- Tester chaque rôle avec un compte représentatif.
- Tester les denies sur les actifs critiques.
- Vérifier que `_all` ne révèle pas les providers non autorisés.
- Lister dans `allowedOrigins` exactement les origines navigateur qui doivent
  accéder au broker, avec le bon schéma et le bon port, et aucune autre. Une page
  servie par ce broker compte aussi comme une origine navigateur.
- Laisser `audit.logAllowed` à `false` après le diagnostic.
- Redémarrer le broker après toute modification, car les politiques sont
  chargées une seule fois au démarrage.

## Pour aller plus loin

- [Référence complète de configuration](../docs/config.md)
- [Guide OAuth du broker](../../../../docs/authorization.md)
- [Autorisation hiérarchique](../../../../docs/hierarchical-authorization.md)
- [Points d'entrée et transports](../../../../docs/endpoints.md)

Ou demandez au broker lui-même : le slot réservé `_broker` expose un outil
`broker_guide` (guides d'intégration, écrits depuis le code source) et un outil
`broker_diagnose` (état en direct et problèmes prouvés, chacun avec sa
correction).
