docker builder prune -f
docker build --no-cache --platform linux/amd64,linux/arm64 -t motomura-io .
docker tag auto-motomura-app asia-northeast1-docker.pkg.dev/motomuraplatform/motomura-io/motomura-io:v1
docker push asia-northeast1-docker.pkg.dev/motomuraplatform/motomura-io/motomura-io:v1

openssl rand -hex 32

 kubectl -n motomura rollout restart auto-motomura-app