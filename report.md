# Rapport TP Docker - Réplication PostgreSQL, Cache Redis & Haute Disponibilité

## 1. Schéma d'Architecture
L'architecture mise en place est la suivante :

- **API (Node.js)** : Point d'entrée pour les clients.
- **HAProxy** : Répartiteur de charge (Load Balancer) pour les écritures (Writes). Redirige vers le noeud Primary actif.
- **PostgreSQL Primary** : Base de données principale pour les écritures.
- **PostgreSQL Replica** : Base de données secondaire en lecture seule (Hot Standby), synchronisée par Streaming Replication.
- **Redis** : Cache pour les lectures rapides.

Flux de données :
- **Écritures (POST/PUT)** : API -> HAProxy -> PostgreSQL Primary.
- **Lectures (GET)** : API -> Redis (Hit) OU API -> PostgreSQL Replica (Miss).

## 2. Stratégie de Lecture/Écriture
- **Write** : Toujours redirigé vers le Primary via HAProxy. Cela garantit la cohérence des données et évite les conflits.
- **Read** :
  1. Vérification dans le Cache Redis.
  2. Si absent (Cache Miss), lecture sur le Replica.
  3. Mise en cache du résultat pour les lectures futures.

Cette séparation permet de décharger le Primary des lectures intensives.

## 3. Stratégie de Cache
- **Pattern** : Cache-Aside. L'application gère le cache explicitement.
- **Clé** : `product:{id}`.
- **TTL** : 60 secondes. Choisi pour éviter de garder des données trop obsolètes tout en offrant un bon taux de hit.
- **Invalidation** : Lors d'un `PUT` (mise à jour), le cache correspondant est supprimé (`DEL`) pour forcer une mise à jour lors de la prochaine lecture.

## 4. Retour sur la Haute Disponibilité (HA)
Lors des tests de résilience :
- **Panne Redis** : L'API continue de fonctionner en lisant directement sur le Replica (dégradation de performance mais service maintenu).
- **Panne Replica** : Les lectures échouent (Erreur 500) car aucun mécanisme de fallback vers le Primary n'a été implémenté pour la lecture (choix architectural strict).
- **Panne Primary** : Les écritures échouent immédiatement.
- **Failover Manuel** :
  - Arrêt du Primary.
  - Promotion du Replica (`pg_ctl promote`) -> Il devient Primary.
  - Mise à jour de la configuration HAProxy pour pointer vers le nouveau Primary.
  - Redémarrage HAProxy.
  - Le service d'écriture est rétabli.

## 5. Réponses aux Questions

**1. Différence entre réplication et haute disponibilité ?**
La **réplication** consiste à copier les données d'un serveur à un autre pour la redondance ou la distribution de charge lecture. Elle ne garantit pas automatiquement la continuité de service.
La **haute disponibilité (HA)** garantit que le service reste accessible même en cas de panne, souvent via des mécanismes de bascule automatique (failover) et de redondance. La réplication est une brique de la HA, mais pas suffisante seule.

**2. Qu’est-ce qui est manuel ici ? Automatique ?**
- **Automatique** : La synchronisation des données (Réplication Streaming), la gestion du cache (via le code API).
- **Manuel** : La détection de la panne du Primary, la promotion du Replica, et la reconfiguration du point d'entrée (HAProxy). C'est une procédure d'astreinte.

**3. Risques cache + réplication ?**
- **Incohérence** : Latence de réplication. On écrit sur le Primary, on lit sur le Replica. Si le Replica a du retard, on lit une donnée périmée (Stale Read).
- **Cache invalidation** : Si le cache n'est pas invalidé correctement (bug, panne réseau Redis lors du DEL), l'utilisateur voit une vieille donnée pendant la durée du TTL.

**4. Comment améliorer cette architecture en production ?**
- **Failover Automatique** : Utiliser un outil comme **Patroni** ou **Repmgr** pour gérer l'élection du Primary et la bascule automatique.
- **Proxy Dynamique** : Configurer HAProxy pour vérifier dynamiquement l'état (check script) ou utiliser un DNS dynamique / VIP.
- **Cache Distribué** : Redis Cluster ou Sentinel pour la HA du cache.
- **Consistance** : Utiliser `Synchronous Replication` si la perte de données est inacceptable (au prix de la performance).
