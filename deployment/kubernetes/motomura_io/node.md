docker builder prune -f
docker build --no-cache --platform linux/amd64,linux/arm64 -t motomura-io .
docker tag motomura-io asia-northeast1-docker.pkg.dev/motomuraplatform/motomura-io/motomura-io:v22
docker push asia-northeast1-docker.pkg.dev/motomuraplatform/motomura-io/motomura-io:v22

openssl rand -hex 32

kubectl -n motomura rollout restart motomura-io

kubectl get managedcertificate motomura-io-cert --namespace motomura
kubectl describe managedcertificate motomura-io-cert --namespace motomura
kubectl delete managedcertificate motomura-io-cert --namespace motomura

gcloud auth login
gcloud config set project motomuraplatform
gcloud container clusters get-credentials motomura-cluster \
  --region asia-northeast1 \
  --project motomuraplatform


https://motomura.io/api