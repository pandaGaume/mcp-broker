# Brief : une identité, plusieurs déclarations, une par slot

Statut : proposition, 2026-10-06. Demandé par mcp-open-api, après le banc de son moteur.

## En une phrase

Aujourd'hui, une identité de provider tient **une** déclaration, donc **un** domaine. On propose qu'elle tienne **une déclaration par slot** qu'elle publie, chacune avec son domaine, pour qu'un même hôte serve plusieurs slots gouvernés sans qu'ils s'écrasent.

## Le modèle, inchangé

Une ressource gouvernée est un **nom qualifié** : un domaine et un chemin. `scada:/site/nord/**` et `vannes:/site/nord/**` sont deux ressources distinctes, même si leurs chemins se recouvrent. Ce que mcp-scada protège lui appartient et ne concerne aucun autre domaine.

- **Un domaine a un propriétaire**, comme un espace de noms d'URN a une autorité. Le broker l'applique déjà (`domain "<d>" is already declared by provider "<id>"; a domain has one owner`), et ce brief n'y touche pas.
- **Les droits sont qualifiés** par le préfixe de capacité : une assignation `scada.*` sur `/site/**` ne donne rien sur les ressources de `vannes`.
- **Un chemin non qualifié**, écrit dans la politique (`slotResources`, la `resource` d'une assignation), est commun à tous les domaines : `/site/**` couvre les ressources de chacun.
- Deux domaines différents peuvent donc déclarer des namespaces qui se recouvrent ; le broker ne le vérifie pas, et il a raison.

## Le problème

`BrokerAuthority` garde les déclarations dans `_declarations: Map<principalId, IProviderDeclaration>` (`authority/broker.authority.ts`), et `broker/authorize` retrouve la déclaration par l'identité qui demande (`declarationOf(principal.id)`), sans tenir compte du slot d'où vient la demande, alors que `origin.slot` est connu. Une identité qui déclare à nouveau **remplace** sa déclaration précédente, quel que soit le slot.

Un hôte qui publie plusieurs slots gouvernés sous une seule identité les voit donc s'écraser, en silence :

1. mcp-open-api sert `vannes` (domaine `vannes`) et déclare ;
2. il sert `pompes` (domaine `pompes`) et déclare : cette déclaration **remplace** celle de `vannes` ;
3. `vannes` est toujours publié, mais chaque `authorize` de ses outils répond `undeclared-capability`. Aucune erreur, nulle part.

Le contournement actuel, une identité par slot, oblige l'exploitant à écrire une entrée `providers` par slot servi, et à la tenir à jour à chaque publication. Pour un hôte dont le rôle est justement de publier des slots à la demande (mcp-open-api, mcp-designer), ce n'est pas tenable.

## La proposition

- Les déclarations sont indexées par le couple **(identité, slot)**.
- `broker/authorize` cherche la déclaration de l'identité qui demande, **pour le slot d'où vient la demande** (`origin.slot`).
- Déclarer à nouveau depuis le même slot remplace la déclaration de ce slot, et d'aucun autre.
- Une identité peut donc posséder plusieurs domaines, un par slot. La règle « un domaine, un propriétaire » s'applique comme aujourd'hui : un domaine possédé par une autre identité est refusé. Une même identité peut aussi déclarer le même domaine depuis deux slots.
- La rétention ne change pas : un domaine reste à son propriétaire tant que le broker tourne, même déconnecté.
- Un provider qui ne publie qu'un slot ne voit aucune différence.

### Ce qui suit la déclaration par slot

- **Ressources concrètes** : la règle d'échappement (même identifiant natif sous un autre chemin) s'applique dans la déclaration du slot.
- **Motifs de limites (1.7.0)** : ceux d'une déclaration ne valent que pour son slot ; les `resourceLimits` de l'exploitant s'appliquent à tous, comme aujourd'hui.
- **`protects`** : une protection est confirmée par la déclaration du slot protégé.
- **`resultsRequired`, `budgetUnits`, budgets** : par déclaration, donc par slot.
- **Références d'appelant** : déjà valables sur le slot de la requête seulement ; rien ne change.

### L'identifiant natif, qualifié par le domaine

L'identifiant natif d'une vérification (`checks[].resource`) n'est lu que par l'audit. La documentation recommandera la forme qualifiée `<domaine>:<chemin>` (`vannes:/site/nord/valves/V-012`), pour qu'une ligne d'audit se lise sans ambiguïté quand deux domaines couvrent le même chemin.

### Visibilité

- `broker_info` et `broker://authority` listent les déclarations avec leur slot et leur domaine.
- L'audit d'une décision porte le slot de la déclaration utilisée.

### Retrait administratif (optionnel)

`AGENTS.md` le dit : un domaine déplacé vers une autre identité demande aujourd'hui un redémarrage. Un hôte qui publie et retire des slots à la demande le rencontrera plus souvent. Proposition : un outil `_broker`, `broker_declaration_release({ principal, slot })`, qui exige `broker.authority.admin`, est audité, change `policyVersion`, et libère le domaine si aucune autre déclaration du même propriétaire ne le porte. Refusé tant que le provider est connecté à ce slot.

## Compatibilité

- **Additif** pour un provider qui ne publie qu'un slot.
- **Un comportement change** : une identité qui déclarait depuis un slot, puis depuis un autre, voyait la seconde déclaration remplacer la première ; elle en garde maintenant deux. Aucun provider connu de la famille ne s'appuie sur ce remplacement (mcp-scada et mcp-vault déclarent depuis un seul slot) ; à vérifier avant la version.
- Rien de ce qui était accepté ne devient refusé.

## Lots

| lot | contenu | critère d'acceptation |
| --- | --- | --- |
| 1 | déclarations indexées par (identité, slot) ; `authorize` cherche par `origin.slot` | une identité qui sert `vannes` et `pompes`, deux domaines, garde les deux déclarations ; chaque `authorize` voit celle de son slot |
| 2 | slot et domaine dans `broker_info`, `broker://authority` et l'audit ; forme qualifiée de l'identifiant natif documentée | les vues de droits montrent chaque déclaration avec son slot |
| 3 | `broker_declaration_release` (optionnel) | un domaine libéré se redéclare sous une autre identité sans redémarrer ; refus si le provider est connecté |

Le kit de test (`startTestBroker`) n'a rien à changer : il crée déjà des identités de provider, et un test peut servir plusieurs slots sous la même.

## Documentation à mettre à jour

`AGENTS.md` (section « Declared authorization » : « an identity holds one declaration, hence one domain »), `docs/authorization.md`, le guide `broker_guide` (topic `publish-provider`).

## Questions ouvertes

- **Un même domaine depuis deux slots d'une même identité** : faut-il l'accepter ? Les deux déclarations pourraient porter des ressources concrètes de même identifiant natif avec des limites différentes.
- **Retrait d'un provider vivant** : le lot 3 le refuse ; faut-il une option qui déconnecte d'abord le provider ?
