slack
microsoft teams
chatwork
line works
microsoft teams
zoom
kintone

curl -X GET "https://api.kingtime.jp/v1.0/employees" \
  -H "Authorization: 5d9b376ce3a046b5a2528372c0b71955" \
  -H "Content-Type: application/json"


  docker exec javitalk_automation-postgres-1 psql -U javitalk -c "CREATE DATABASE activepieces OWNER javitalk;"
docker exec javitalk_automation-postgres-1 psql -U javitalk -c "CREATE DATABASE langfuse OWNER javitalk;"
docker restart javitalk_automation-activepieces-1 javitalk_automation-langfuse-1
docker logs javitalk_automation-activepieces-1 

docker compose up -d
docker-compose up -d --force-recreate
docker-compose up -d --force-recreate activepieces


## I MEMORY SOME COMMANDS TO HELP ME EASY TO REMEMBER. PLEASE IGNORE THIS FILE
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

lsof -ti tcp:8081 | xargs kill
python -m uvicorn app.main:app --reload --port 8081

alembic upgrade head
unsloth studio -H 0.0.0.0 -p 8888

uvicorn app.main:app --reload --port 8081
pip install -e ".[dev]"

# Inside the AP monorepo
ln -s /Users/hoanganhsong/Projects/SONG/javitalk/javitalk_automation/pieces/piece-chatwork /Users/hoanganhsong/Projects/SONG/javitalk/javitalk_automation/activepieces/packages/pieces/custom

npm ls -g --depth=0
cd pieces/piece-chatwork && npm run build
npx nx build pieces-zalo
npx turbo run build --filter=@activepieces/piece-zalo
npx turbo run build --filter=@activepieces/piece-chatwork
npx turbo run build --filter=@activepieces/piece-motomura
npx turbo run build --filter=@activepieces/piece-kingoftime

cd piece-chatwork
npm link
cd activepieces
npm link @activepieces/piece-chatwork
npm link @javitalk/piece-chatwork

npm ls -g --depth=0

cd activepieces
npm run dev
npm run dev:backend
npm run dev:frontend
npm run dev:api

npm run serve:backend
npm run serve:worker
npm run serve:frontend
npm run serve:engine

Email: dev@ap.com Password: 12345678

nvm install 22
nvm use 22

git clone https://github.com/hoanganhsong1/javitalk_activepieces.git custom


npm run cli pieces create
lsof -ti :3000 | xargs kill -9
node tools/setup-dev.js

rm dev/config/pglite/postmaster.pid
rm -rf activepieces/dev/config/pglite

generate key AP_JWT_SECRET, 
openssl rand -hex 32
generate key AP_ENCRYPTION_KEY,
openssl rand -hex 16

npm run
npm run db-migration

INITIAL DATABASE
cd packages/server/api

bun run \
ts-node \
--transpile-only \
-r tsconfig-paths/register \
-P tsconfig.app.json \
node_modules/typeorm/cli.js migration:run \
-d src/app/database/migration-data-source.ts

npm run sync-pieces
npm run sync-pieces -- -h http://localhost:3000

npm run build-piece
or cd packages/pieces/custom/chatwork
npm run build
rm -rf dev/cache

rm -rf .activepieces
rm -rf .pglite
rm -rf node_modules/.cache
rm -rf node_modules/.bun
rm -rf ~/.bun/install/cache
rm -rf ~/.pglite

rm -rf .activepieces .pglite node_modules/.cache node_modules/.bun ~/.bun/install/cache ~/.pglite
