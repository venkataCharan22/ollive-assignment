# Kubernetes deployment

Manifests target a self-hosted single-node cluster (k3s, kind, MicroK8s) but
work on any Kubernetes ≥1.27. Designed for the Ollive assignment bonus.

## Apply order

```bash
# 1. Build images and load into your cluster's registry.
#    For kind:
#      docker compose build
#      kind load docker-image ollive/ingestion:latest ollive/chatbot:latest
#    For k3s:
#      docker compose build
#      docker save ollive/ingestion:latest | sudo k3s ctr images import -
#      docker save ollive/chatbot:latest   | sudo k3s ctr images import -

# 2. Apply everything in order.
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/10-secrets.yaml     # edit first!
kubectl apply -f k8s/20-postgres.yaml
kubectl apply -f k8s/30-redis.yaml
kubectl apply -f k8s/40-ingestion.yaml
kubectl apply -f k8s/50-chatbot.yaml
# Optional, if you have an ingress controller:
kubectl apply -f k8s/60-ingress.yaml
```

## Access without an ingress

```bash
kubectl -n ollive port-forward svc/chatbot 3000:80
# open http://localhost:3000
```

## Notes

- The ingestion Deployment runs `prisma migrate deploy` on container start.
  Idempotent — safe across replicas; the first one wins, the rest no-op.
- HPA scales ingestion 2→10 on CPU. Redis Streams' consumer groups make this
  safe — each event is dispatched to exactly one worker.
- Secrets here are *demo*. In production, switch to External Secrets Operator
  pulling from AWS Secrets Manager / GCP Secret Manager / Vault, or use
  Sealed Secrets to commit encrypted values to git.
- For production Postgres, swap the StatefulSet for a managed instance
  (RDS, Cloud SQL) or use the CloudNativePG operator.
