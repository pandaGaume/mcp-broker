# Du développement ouvert à la production

Ce guide explique comment démarrer un provider de la famille CyanMycelium sans politique locale, tester ensuite les autorisations sans serveur OAuth, puis passer en production. Les exemples utilisent le slot `persistence`. Le nom `--dev` appartient au lanceur de mcp-persistence ; ce n'est pas une option CLI universelle de mcp-broker.

## Choisir le mode

| Mode | Identité client | Guard du provider | Usage |
|---|---|---|---|
| Développement ouvert | aucune requise | `openGuard()` | travailler sur les fonctions métier en local |
| Développement avec politique | jetons statiques `auth.dev` | `BrokerAccessGuard` | vérifier les permissions, refus et audits |
| Production | jetons validés par OAuth/JWKS | `BrokerAccessGuard` | exploiter le service avec contrôle d'accès |

`auth.dev` remplace l'authentification OAuth, sans désactiver la politique. `openGuard()` accepte les contrôles du provider sans consulter le broker et n'émet aucun audit d'autorisation. Désactiver l'authentification du broker ne transforme pas un `BrokerAccessGuard` en guard ouvert : sans référence d'appelant, celui-ci refuse.

Le mode ouvert concerne les autorisations. Les validations de formats, les préconditions de révision, les hashes, les quotas et l'intégrité du stockage restent actifs.

## 1. Développer en local avec openGuard

Dans le code d'assemblage du provider, le choix doit être explicite :

```ts
import { BrokerAccessGuard, openGuard } from "@cyanmycelium/mcp-uns";

const dev = process.argv.includes("--dev");
const guard = dev
    ? openGuard()
    : new BrokerAccessGuard(transport.broker);
```

Injecter ce guard dans le behavior métier. L'option est lue par le processus au démarrage ; elle ne vient ni des arguments d'un outil MCP ni d'une requête HTTP. Au démarrage normal, une configuration manquante doit arrêter le processus. Ne jamais installer `openGuard()` dans un `catch` après un échec d'authentification, de déclaration ou de connexion.

Pour un provider générique, démarrer un broker local distinct, sans bloc `auth`, sans table `providers` et sans `providerSecret` :

```powershell
# Depuis la racine de mcp-broker, après installation et compilation de node/.
$env:MCP_BROKER_HOST = '127.0.0.1'
$env:MCP_BROKER_PORT = '3000'
node node/packages/broker/dist/bin.js
```

Utiliser un environnement de développement propre : une variable `MCP_BROKER_SECURITY_FILE` ou une configuration `.mcp-broker` déjà chargée peut activer une sécurité qui n'apparaît pas dans cette commande. Contrôler la bannière et l'état effectif avec `broker_info`.

Publier le provider avec `DirectTransport("ws://127.0.0.1:3000/provider/persistence")`. Utiliser `http://127.0.0.1:3000/persistence/mcp` côté client. Aucun secret provider n'est nécessaire dans ce mode. Sans identité propre, ne pas déclarer un domaine d'autorisation au broker. Le behavior utilise le guard ouvert pour ses contrôles métier.

Le lanceur local de mcp-persistence encapsule ce démarrage dans `npm run dev` : il crée lui-même un broker loopback et refuse un port déjà occupé. Ne pas démarrer un deuxième broker sur ce port. Les commandes du provider et son stockage sont décrits dans son propre README.

Le broker et les endpoints de transfert ouverts doivent écouter sur loopback, sans exposition par proxy. Séparer les données de dev de celles de production. L'origine HTTP reste un réglage distinct : une page de navigateur doit être présente dans `allowedOrigins` même si elle est servie par un montage statique du broker.

## 2. Tester la politique avec auth.dev

Cette étape retire déjà `openGuard()`. Elle permet de vérifier les décisions réelles avant de configurer OAuth.

Créer un fichier de sécurité local, par exemple `.mcp-broker/security.dev.json` :

```json
{
  "auth": {
    "dev": {
      "callers": [
        { "id": "explorer", "tokenEnv": "BROKER_TOKEN_EXPLORER", "groups": ["persistence-writers"] },
        { "id": "reader", "tokenEnv": "BROKER_TOKEN_READER", "groups": ["persistence-readers"] },
        { "id": "outsider", "tokenEnv": "BROKER_TOKEN_OUTSIDER" }
      ]
    },
    "slotResources": { "persistence": "/site1/persistence" },
    "roles": {
      "caller": { "capabilities": ["mcp.tools.list", "mcp.tools.call", "mcp.resources.read"] },
      "reader": { "capabilities": ["persistence.read"] },
      "writer": { "capabilities": ["persistence.read", "persistence.write", "persistence.delete"] }
    },
    "assignments": [
      { "id": "writers-call", "subject": "group:persistence-writers", "role": "caller", "resource": "/site1/persistence" },
      { "id": "readers-call", "subject": "group:persistence-readers", "role": "caller", "resource": "/site1/persistence" },
      { "id": "writers-data", "subject": "group:persistence-writers", "role": "writer", "resource": "/site1/persistence/namespaces/explorer/**" },
      { "id": "readers-data", "subject": "group:persistence-readers", "role": "reader", "resource": "/site1/persistence/namespaces/explorer/**" }
    ]
  },
  "providers": [
    {
      "id": "mcp-persistence",
      "secretEnv": "PERSISTENCE_PROVIDER_SECRET",
      "subjects": ["service:mcp-persistence"],
      "allowedResources": ["/site1/persistence/**"]
    }
  ]
}
```

Générer quatre secrets distincts et les injecter dans l'environnement du broker. Les jetons dev font au moins 16 caractères. Les valeurs ne sont pas écrites dans le fichier JSON :

```powershell
$env:BROKER_TOKEN_EXPLORER = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:BROKER_TOKEN_READER = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:BROKER_TOKEN_OUTSIDER = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:PERSISTENCE_PROVIDER_SECRET = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:MCP_BROKER_SECURITY_FILE = '.mcp-broker/security.dev.json'
$env:MCP_BROKER_HOST = '127.0.0.1'
node node/packages/broker/dist/bin.js
```

Les processus provider et clients doivent recevoir leurs variables par le lanceur ou l'environnement du terminal concerné. Un nouveau terminal n'hérite pas des variables définies dans un terminal voisin. Ne pas copier les valeurs dans une commande suivie par Git.

Le provider se connecte avec son secret, utilise `BrokerAccessGuard` et attend l'acceptation de sa déclaration :

```ts
const transport = new DirectTransport(
    "ws://127.0.0.1:3000/provider/persistence",
    { secret: process.env.MCP_PERSISTENCE_PROVIDER_SECRET }
);
const guard = new BrokerAccessGuard(transport.broker);
// Construire le serveur avec ce transport et ce guard, puis server.start().
await transport.broker.declare(buildPersistenceDeclaration({
    version: "1",
    namespace: "/site1/persistence"
}));
```

Dans l'environnement du provider, `MCP_PERSISTENCE_PROVIDER_SECRET` contient la même valeur que `PERSISTENCE_PROVIDER_SECRET` côté broker. Pour mcp-persistence, définir aussi `MCP_PERSISTENCE_RESOURCE_ROOT=/site1/persistence`, `MCP_PERSISTENCE_BROKER_URL=http://127.0.0.1:3000`, puis lancer `npm start`, sans `--dev`. Le port local de transfert est 3001 par défaut. Les clients transmettent `Authorization: Bearer <leur jeton>` au broker et au transfert de fichiers.

`auth.dev` va uniquement dans le fichier de sécurité. Il est incompatible avec `auth.enabled: true` et `MCP_BROKER_AUTH_ENABLED`. Sans `networks`, seuls les clients loopback sont acceptés. `networks: ["lan"]` ou des CIDR peuvent être ajoutés pour un banc partagé ; cela garde l'authentification et la politique actives.

## 3. Sortir de openGuard et passer en production

1. Arrêter le provider ouvert et son éventuel broker embarqué. Choisir une racine de données dédiée à la production et une configuration de service reproductible.
2. Lancer le broker comme service distinct. Fournir son fichier de sécurité et ses secrets par l'environnement du service ou un gestionnaire de secrets.
3. Remplacer le bloc `auth.dev` par la configuration OAuth ci-dessous. Conserver les rôles et assignations examinés lors des tests. Adapter `subjectMapping` aux claims réellement signés par le serveur d'identité.
4. Conserver une identité propre au provider dans `providers`. Un secret partagé global n'identifie pas le provider et ne suffit pas pour une déclaration d'autorité.
5. Lancer le provider sans `--dev`, avec `BrokerAccessGuard`, son secret et la même racine de ressources que `slotResources` et `allowedResources`. Refuser le démarrage si le secret ou l'acceptation de déclaration manque.
6. Servir broker et transferts derrière HTTPS, ou utiliser TLS natif pour le broker. Le port de transfert de mcp-persistence reste loopback derrière le proxy. Transmettre le header `Authorization`, préserver le streaming et borner les tailles et délais du proxy. Retirer toute route publique vers un ancien provider ouvert.
7. Donner aux clients des jetons OAuth et les endpoints du slot. Exécuter la recette d'accès ci-dessous avant d'ouvrir le service aux applications.

Dans le même objet `auth` que les rôles et assignations, remplacer uniquement `dev` par ces champs, avec les valeurs de l'environnement réel :

```json
{
  "enabled": true,
  "publicBaseUrl": "https://mcp.example.com",
  "authorizationServers": ["https://auth.example.com"],
  "jwks": "https://auth.example.com/.well-known/jwks.json",
  "issuer": "https://auth.example.com",
  "scopesSupported": ["mcp:call"],
  "requiredScopes": ["mcp:call"],
  "subjectMapping": {
    "userClaim": "sub",
    "groupClaims": ["groups"],
    "clientClaim": "client_id"
  }
}
```

Ce fragment complète `auth` ; il ne remplace pas le fichier de sécurité entier. Les groupes `persistence-writers` et `persistence-readers` doivent provenir des claims validés. Aucune capacité `persistence.admin` n'est accordée dans l'exemple : la purge reste refusée tant qu'un rôle d'administration et son assignation n'ont pas été décidés.

`withDevAuth()` en bibliothèque correspond à `auth.dev` côté CLI. En production embarquée, utiliser `withJwtAuth()` et installer la même politique avec `withAuthorizationPolicy()`. Ces modes sont documentés dans [config.md](node/packages/broker/docs/config.md#authdev-development-tokens-no-authorization-server).

## 4. Vérifier le changement de mode

| Vérification | Résultat attendu |
|---|---|
| Démarrage normal du provider sans secret | échec, aucun fallback ouvert |
| Connexion du provider avec un mauvais secret | refus de publication |
| Déclaration hors de allowedResources | refus de déclaration |
| Appel sans jeton ou avec un jeton invalide | refus avant les données métier |
| Writer sur explorer | lecture et écriture autorisées |
| Reader sur explorer | lecture autorisée, mutation refusée |
| Writer ou reader sur un autre namespace | refus, liste filtrée |
| Outsider | accès au slot refusé |
| Ressource, révision et téléchargement non autorisés | refus identique à celui de l'outil correspondant |
| Accès révoqué avant un nouveau téléchargement | nouveau flux refusé |
| Purge sans rôle admin | refus |
| Deux écritures sur la même expectedRevision | un succès, un conflit, même en mode ouvert |
| Upload incomplet ou hash incorrect | aucun artefact disponible, même en mode ouvert |

Un flux déjà ouvert n'est pas interrompu automatiquement lors d'un changement de politique. Tester la révocation sur une nouvelle requête et appliquer les durées et limites de transfert du service.

Utiliser `broker_info`, `provider_status` et `broker_diagnose` sur `_broker` avec un compte d'exploitation disposant des capacités d'introspection nécessaires. L'exemple applicatif ci-dessus n'accorde pas ces droits. Vérifier l'identité provider, la déclaration, les ressources et les décisions d'audit. `server.start()` confirme seulement l'ouverture du socket, pas l'acceptation du slot.

La référence d'appelant du broker reste valable pendant la requête et sur son slot. Le provider ne doit pas la conserver comme identité stable ou l'utiliser après sa réponse. Un endpoint de fichiers doit obtenir une décision actuelle en authentifiant son propre appelant ; un identifiant d'upload, un chemin ou une URL ne constitue pas une permission.

## 5. Découverte LAN par mDNS, depuis 1.11.0

L'annonce DNS-SD/mDNS est **désactivée par défaut**, en mode ouvert comme en mode authentifié. Aucun socket mDNS n'est créé sans `mdns.enabled: true`. Elle complète une adresse configurée ou un DNS administré ; dans les réseaux segmentés, conserver ces derniers comme mécanismes principaux.

### Convention d'annonce, version 1

Le type privé de la famille est `_mcp-broker._tcp.local.`. Ce nom ne prétend pas être un standard MCP ni un type enregistré auprès de l'IANA.

| Enregistrement | Contenu |
|---|---|
| PTR | instance du broker, nom opaque par défaut |
| SRV | hostname `.local` et port TCP annoncé |
| A | adresses IPv4 des interfaces explicitement sélectionnées |
| TXT `txtvers=1` | version de notre convention |
| TXT `scheme=https` | protocole ; `http` exige l'option dev explicite |
| TXT `path=/_broker/mcp` | chemin effectif d'introspection, adapté aux chemins personnalisés et au préfixe du proxy |
| TXT `origin=https://mcp.site.example` | présent uniquement avec publicBaseUrl, pour conserver le nom canonique du certificat et du virtual host |

Sans origin, construire le candidat avec scheme, hostname SRV, port SRV et path. Avec origin, utiliser cette origine et path, sans ajouter une seconde fois le préfixe du proxy. **Aucune de ces valeurs ne prouve l'identité du broker.**

L'annonce n'inclut ni secrets, ni utilisateurs, ni slots métier, ni version logicielle précise. Par défaut, instance et hostname sont aléatoires à chaque démarrage. Les options name et hostname permettent des labels opérateur neutres, de 48 caractères ASCII maximum. Les endpoints effectifs et les slots se découvrent ensuite avec les outils `_broker`, après authentification et selon les droits d'introspection.

### Configuration et interfaces

Exemple de `.mcp-broker/config.json`, derrière un proxy HTTPS :

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "securityFile": "security.json",
  "mdns": {
    "enabled": true,
    "interfaces": ["Ethernet"],
    "publicBaseUrl": "https://mcp.site.example"
  }
}
```

interfaces contient les noms exacts des interfaces du poste hébergeant le broker, chacune avec une adresse IPv4 non-loopback. Une interface absente, une liste vide ou un listener inaccessible sur les adresses sélectionnées font échouer le démarrage. Aucun choix automatique de toutes les interfaces, aucun ajout automatique de VPN. Cette première version annonce IPv4 uniquement, comme le récepteur actuel de mcp-network-discovery.

publicBaseUrl contient l'origine et l'éventuel préfixe HTTP du proxy, sans identifiants, query string ni fragment. Le port annoncé est celui de cette URL. L'opérateur garantit que le proxy écoute à ce port sur les adresses LAN annoncées, que le DNS est correct, que le bearer est transmis et que le certificat correspond au nom canonique. Le broker ne vérifie pas lui-même le routage ni le certificat du proxy.

Sans proxy, omettre publicBaseUrl : le port réellement lié et les chemins effectifs du broker sont annoncés. Le client doit alors pouvoir valider le certificat du hostname `.local`, par exemple avec une autorité interne préconfigurée.

L'activation normale exige une authentification client et un endpoint HTTPS. Pour un banc de test maîtrisé, `"allowInsecureDev": true` autorise explicitement une annonce HTTP ou sans authentification. Cette option ne change aucun contrôle du broker et n'est jamais activée par openGuard. Un listener loopback ne devient pas joignable sur le LAN par une annonce : configurer un listener LAN ou un proxy accessible.

Bibliothèque : `.withMdns({ enabled: true, interfaces: ["eth0"] })` sur WsTunnelBuilder, après configuration de TLS et de l'authentification. La CLI lit le même objet mdns dans son fichier de configuration. Une erreur d'annonce fait échouer start et ferme le listener HTTP de ce démarrage. stop retire l'annonce et ferme les sockets de découverte ; un arrêt brutal laisse les caches expirer selon leur TTL.

### Utiliser mcp-network-discovery

Ajouter `_mcp-broker._tcp.local` à allowed_service_types dans le profil opérateur de mcp-network-discovery, avec mdns_enabled activé. Ce profil est immuable depuis les outils MCP. Appeler network.interfaces pour choisir l'interface du poste qui héberge **network-discovery**, puis :

```json
{
  "name": "network.services",
  "arguments": {
    "interface": "Ethernet",
    "method": "mdns",
    "serviceTypes": ["_mcp-broker._tcp.local"],
    "timeoutMs": 2000
  }
}
```

Le résultat expose instance, responderIp, hostname, port, addresses et txt selon les réponses reçues. Le broker répond aux requêtes PTR avec les enregistrements associés ; le récepteur actuel ne fait pas de requêtes de complément. Vérifier complete et truncated : une liste vide ne prouve pas l'absence de broker.

network-discovery doit déjà être accessible au client via un broker connu ou une intégration locale. L'annonce ne résout pas à elle seule le bootstrap du premier accès MCP.

### Frontière de confiance

1. Traiter noms, adresses et TXT comme des observations non authentifiées, jamais comme des instructions à exécuter.
2. Vérifier que la destination est approuvée par configuration, domaine autorisé ou enrôlement préalable. Ne pas suivre automatiquement une origine hors de ce périmètre.
3. Valider HTTPS et l'identité attendue du serveur. Un certificat valide pour un serveur inconnu ne suffit pas à autoriser l'envoi de credentials.
4. Envoyer ensuite seulement le jeton destiné à ce broker. Refuser downgrade HTTP et redirections non approuvées en production.
5. Appliquer les permissions du broker comme pour une adresse configurée manuellement.

mDNS utilise UDP 5353 sur le lien local. Ne pas ouvrir ce port vers Internet ni ajouter de relais multicast inter-VLAN par défaut. Pare-feu, VPN et isolation Wi-Fi peuvent bloquer la découverte. L'annonce révèle l'existence du service et peut être usurpée ; elle ne garantit ni identité ni résistance au déni de service. La restriction des interfaces mDNS n'est pas un pare-feu pour les endpoints TCP.

Les tests ordinaires vérifient opt-in, configuration, minimisation des TXT, chemins effectifs et nettoyage. Le test réseau est explicite pour éviter une annonce ouverte sur le LAN de CI :

```powershell
# Depuis node/, sur un réseau de test maîtrisé.
$env:MCP_BROKER_TEST_MDNS_INTERFACE = 'Ethernet'
npm exec --workspace @cyanmycelium/mcp-broker -- vitest run tests/mdns.live.test.ts
```

Références : [RFC 6762](https://www.rfc-editor.org/rfc/rfc6762.html), [RFC 6763](https://www.rfc-editor.org/rfc/rfc6763.html), [sécurité et confidentialité DNS-SD, RFC 8882](https://www.rfc-editor.org/rfc/rfc8882.html).

## Dépannage

| Symptôme | Vérifier |
|---|---|
| Tout est no-matching-grant | identité client et assignations, pas seulement le secret provider |
| Tout est no-caller-reference côté guard | déclaration acceptée, requête passée par le broker, métadonnées transmises au guard |
| Le lancement ouvert est refusé | sécurité héritée de l'environnement, autre broker sur le port, loopback |
| Le browser provider échoue avec un simple error | le navigateur ne peut pas envoyer le header de secret WebSocket |
| La liste d'outils du bridge stdio devient vide | le bridge est anonyme ; utiliser un client HTTP authentifié en production |
| Le fichier de sécurité est refusé | auth dans deux fichiers, auth.dev avec OAuth, secret absent, champ inconnu ou JSON invalide |

Références : [AGENTS.md](AGENTS.md), [configuration](node/packages/broker/docs/config.md), [autorisation](docs/authorization.md), [politique hiérarchique](docs/hierarchical-authorization.md).
