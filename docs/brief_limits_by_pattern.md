# Brief : limites d'ingénierie par motif de ressource, et RE2 dans le broker

Statut : proposition, 2026-10-05. Demandé par mcp-open-api ; utile à mcp-scada.

## En une phrase

Aujourd'hui, une limite d'ingénierie (`minValue`, `maxValue`, `allowedValues`, `destinations`) ne s'attache qu'à une ressource **concrète**, retrouvée par son identifiant natif exact. On propose de l'attacher aussi à un **motif** de chemin (`/nord/valves/{id}`), déclaré par le provider ou posé par l'exploitant dans le fichier de sécurité, toutes les règles applicables étant **intersectées**. Au passage, le broker évalue toutes ses expressions régulières avec RE2 (`re2js`), en temps linéaire.

## Ce qui existe

- Une déclaration porte des ressources concrètes : `{ resource, resourcePath, effect?, limits? }` (`authority/declaration.ts`).
- À chaque `broker/authorize`, le broker retrouve les limites par l'identifiant natif exact de la vérification (`authority/broker.authority.ts`, `declaration.resources.get(nativeResource)`). Une ressource non déclarée mais dans le namespace est autorisée sans limites.
- Le même identifiant natif sous un autre chemin est refusé (`undeclared-resource`) : sinon un appelant échapperait aux limites déclarées pour lui.
- Les limites partent dans `obligations.constraints` avec `effect: "allow-with-constraints"` et `allowed: false`. **Le provider les applique** ; le broker ne voit pas la valeur écrite.
- Les motifs de chemin existants (`ResourcePathPattern`, pour `allowedResources` et les assignations) n'acceptent que des segments entiers : `*` pour un segment, `**` en dernier segment. Pas de `V-1*`.

## Le problème

1. **Des instances qu'on ne peut pas énumérer.** Une API REST publiée par mcp-open-api expose des milliers de vannes (`/valves/{id}`), dont la liste change sans que le provider le sache. mcp-scada aura le même problème sur une installation de quelques milliers de tags. Les déclarer une par une est impossible, ou intenable.
2. **Des classes d'équipements.** Les vannes `V-0xx` vont de 0 à 100 %, la série `V-1xx` est bridée à 60 %. C'est une connaissance du procédé, pas de l'API.
3. **Un exploitant qui resserre sans republier.** Une maintenance impose 0-80 % pendant une semaine. Aujourd'hui seul le provider déclare des limites : il faut republier son manifeste, ou modifier son code. Et quand c'est le même auteur qui écrit le schéma d'entrée et les limites déclarées, celles-ci n'ajoutent rien : le provider vérifie deux fois la même chose.

Le point 3 est le vrai gain : une limite posée par **une autre autorité que le provider**, tracée comme un changement de politique.

## La proposition

### Une entrée par motif dans les déclarations

```json
"resources": [
    { "resourcePattern": "/nord/valves/{id}", "limits": { "minValue": 0, "maxValue": 100 } },
    { "resourcePattern": "/nord/valves/{id}", "where": { "id": "V-1\\d{2}" }, "limits": { "maxValue": 60 } },
    { "resource": "valve:V-012", "resourcePath": "/nord/valves/V-012", "limits": { "maxValue": 40 } }
]
```

- `resourcePattern` : un chemin dont les segments sont littéraux, `*` (un segment), `**` (dernier segment, zéro ou plus), ou `{nom}` (un segment, nommé). Même forme que les chemins OpenAPI et que les gabarits de mcp-open-api, qui peut déclarer ses `resourcePath` tels quels.
- `where` : une expression RE2 par segment nommé, qui doit couvrir le segment entier (ancrage implicite). Sans `where`, `{nom}` vaut `*`.
- Une entrée a soit `resource` et `resourcePath` (concrète, comme aujourd'hui), soit `resourcePattern` (motif). Jamais les deux.
- Le motif doit rester dans le namespace de la déclaration, comme une ressource concrète.

### Des limites posées par l'exploitant

Dans le fichier de sécurité, sous `authorization` :

```json
"resourceLimits": [
    { "id": "maintenance-nord-2026-10", "pattern": "/nord/valves/{id}", "where": { "id": "V-0\\d{2}" }, "limits": { "maxValue": 80 } }
]
```

Même syntaxe, un `id` pour l'audit. Ces limites s'appliquent quelle que soit la déclaration du provider. Elles entrent dans le hash du fichier, donc dans `policyVersion` : ajouter ou retirer une limite est un changement de politique, tracé comme tel.

### L'intersection, sans arbitrage

Pour une vérification, le broker réunit **toutes** les limites qui s'appliquent : l'entrée concrète de l'identifiant natif, chaque motif de la déclaration qui correspond au chemin, chaque entrée `resourceLimits` qui correspond. Il en calcule l'intersection :

| limite | intersection |
| --- | --- |
| `minValue` | le plus grand |
| `maxValue` | le plus petit |
| `allowedValues` | les valeurs présentes dans toutes les listes |
| `destinations` | idem |

Pas de « motif le plus spécifique » à choisir : des limites ne font que resserrer, comme le principe que le broker applique déjà. L'ordre des entrées ne compte pas.

Si l'intersection est vide (`minValue` au-dessus de `maxValue`, ou `allowedValues` vide), la décision est un refus, raison `empty-limits`. Une contrainte que rien ne satisfait ne doit pas partir comme un accord.

### L'audit et le diagnostic

- L'événement d'audit de la décision liste les sources de la contrainte : `limitSources: ["declaration:/nord/valves/{id}", "security:maintenance-nord-2026-10"]`.
- `broker_diagnose` signale les refus `empty-limits` (avec les sources en cause), et les motifs de déclaration dont un `where` ne compile pas.
- `broker_info` et la ressource d'autorité de `_broker` exposent les motifs déclarés et les `resourceLimits`, pour les vues de droits du brief UI SCADA.

### Ce qui ne change pas

- Le provider applique toujours les contraintes ; le broker ne voit pas la valeur.
- Une ressource concrète garde sa règle d'échappement : même identifiant natif, autre chemin, `undeclared-resource`. Les motifs sont indexés par chemin et n'ont pas d'identifiant natif, donc pas d'échappement possible par ce biais.
- Les budgets (`broker/budget/reserve`) utilisent la même intersection que `broker/authorize`.

## RE2 dans le broker

Le broker évalue aujourd'hui une expression régulière avec le moteur de V8, sur une entrée contrôlée par n'importe quel client : la forme `{ pattern, flags }` d'`allowedOrigins` (`bin.ts`), testée contre l'en-tête `Origin` de chaque requête HTTP. Le moteur de V8 procède par retour arrière : une expression mal écrite par l'exploitant, du genre `^(https?://)?([a-z]+)+\.exemple\.fr$`, laisse un client bloquer la boucle d'événements avec un seul en-tête piégé.

Mesuré dans mcp-open-api (`bench/regex.mjs`, Node 22.20, Intel Core Ultra 7 255H), `^(a+)+$` sur 29 caractères :

| moteur | temps |
| --- | --- |
| V8 | 860 ms, et le double à chaque caractère de plus |
| `re2js` | 1 µs |

Sur un motif ordinaire, `re2js` coûte de 0,1 à 0,6 µs, contre quelques dizaines de nanosecondes pour V8 : rien à l'échelle d'une requête.

**Proposition : le broker évalue toutes ses expressions régulières avec `re2js`** : les `where` des motifs, et `allowedOrigins`.

- `re2js` est du JavaScript pur, 872 Ko, sans dépendance, couvert par l'empreinte du lockfile. mcp-open-api a écarté le module natif `re2` (Node 22 et plus seulement, binaire téléchargé sans vérification, `node-gyp` sinon).
- Il fonctionne avec `--disallow-code-generation-from-strings`, que mcp-open-api propose d'activer par défaut.
- RE2 ne connaît ni les références arrière ni les assertions avant ou arrière. Une expression qu'il refuse fait échouer le démarrage avec un message qui le dit, comme le reste de la configuration depuis 1.4.1. **C'est le seul changement incompatible** : un `allowedOrigins.pattern` qui utilise `(?=` ne démarre plus.

## Performance

Une vérification parcourt les motifs de la déclaration concernée et les `resourceLimits`. Les motifs sont compilés à l'acceptation de la déclaration et au chargement du fichier de sécurité, jamais pendant une décision. Pour que le coût ne croisse pas avec le nombre de motifs, ils sont indexés par leurs segments littéraux de tête.

Cible, à mesurer dans un banc : moins de 10 µs par vérification avec 1 000 motifs déclarés.

## Lots

| lot | contenu | critère d'acceptation |
| --- | --- | --- |
| 1 | `re2js` pour `allowedOrigins` ; erreur de démarrage si RE2 refuse l'expression | un en-tête `Origin` piégé contre un motif vulnérable répond en moins d'une milliseconde |
| 2 | `resourcePattern` et `where` dans les déclarations ; intersection ; `empty-limits` ; `limitSources` dans l'audit | une déclaration `/nord/valves/{id}` à 0-100 et un motif `V-1\d{2}` à 60 donnent `maxValue: 60` pour `V-123`, `100` pour `V-012` |
| 3 | `authorization.resourceLimits` dans le fichier de sécurité ; `policyVersion` ; vues dans `broker_info` et `_broker` | une limite d'exploitant resserre sans toucher la déclaration ; la retirer change `policyVersion` |
| 4 | budgets sur la même intersection ; `broker_diagnose` ; banc de performance | le banc tient la cible avec 1 000 motifs |

Le kit de test (`startTestBroker`) accepte les deux nouvelles formes dès le lot 2 (déclarations) et 3 (`policy.resourceLimits`).

## Documentation à mettre à jour

`docs/authorization.md`, la section « Declared authorization » d'`AGENTS.md`, le guide `broker_guide` (topic `publish-provider`), `node/packages/broker/docs/config.md` pour `allowedOrigins` et `resourceLimits`, `node/packages/broker/docs/testing.md`.

## Questions ouvertes

- **Durée de validité.** Une limite d'exploitant pour une maintenance a une fin. Faut-il un `until` (date) sur les `resourceLimits`, ou laisser l'exploitant la retirer ?
- **Limites sans déclaration.** Une entrée `resourceLimits` sur un chemin qu'aucun provider n'a déclaré : refusée au chargement, ou acceptée et appliquée dès qu'une déclaration couvre ce chemin ? La seconde permet de poser les limites avant le premier démarrage du provider.
- **`where` sur `*`.** Faut-il permettre de contraindre un `*` anonyme, ou seulement les segments nommés ?
