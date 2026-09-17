# Boiler Guardian — task runner.
#
# Every target is a thin wrapper over the npm scripts, so nothing here is a second
# source of truth about how the system runs. Override any variable inline:
#
#   make sim FAULT=overpressure DURATION=200
#   make pipeline FROM=600
#
.DEFAULT_GOAL := help
SHELL := /bin/bash

# --- simulator ---------------------------------------------------------------
BOILER   ?= boiler-01
FAULT    ?= low_water
START    ?= 30
DURATION ?= 120
SEED     ?= 42
RATE     ?= 1000

# --- pipeline ----------------------------------------------------------------
FROM     ?= 0

# --- decisions ---------------------------------------------------------------
REPORT   ?=
ACTION   ?= ACKNOWLEDGE
NOTE     ?= checked on the plant
DASHBOARD ?= http://localhost:3100

# --- e2e ---------------------------------------------------------------------
# Seconds to let the worker's subscription settle before the simulator starts, and
# to let the last classifications and reports land before it is stopped.
SETTLE   ?= 10
DRAIN    ?= 25
PIPELINE_LOG ?= /tmp/boiler-pipeline.log

MIRROR ?= https://testnet.mirrornode.hedera.com/api/v1

.PHONY: help install topics sim sim-dry pipeline pipeline-cheap dashboard decide e2e verify typecheck test build clean

help: ## Show this help
	@echo "Boiler Guardian"
	@echo
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Variables: FAULT=$(FAULT) START=$(START) DURATION=$(DURATION) SEED=$(SEED) RATE=$(RATE) FROM=$(FROM)"
	@echo "Faults:    overpressure o2_collapse sensor_flatline tube_rupture low_water"

install: ## Install dependencies (root + web workspace)
	npm install

topics: ## Create the four HCS topics and print the .env block
	npm run setup:topics

sim: ## Run the boiler simulator against the telemetry topic
	npm run sim -- --boiler $(BOILER) --fault $(FAULT) --start $(START) \
		--duration $(DURATION) --seed $(SEED) --rate $(RATE)

sim-dry: ## Run the simulator with no chain writes, frames to stdout
	npm run sim -- --boiler $(BOILER) --fault $(FAULT) --start $(START) \
		--duration $(DURATION) --seed $(SEED) --rate 1 --dry-run

pipeline: ## Run the analysis worker (layers 1-3 + reports)
	npm run pipeline -- --from $(FROM)

pipeline-cheap: ## Run the worker with no model calls (layers 1-2 only)
	npm run pipeline -- --from $(FROM) --no-slm

dashboard: ## Serve the dashboard on http://localhost:3100
	npm run web

decide: ## Publish an operator decision (REPORT=<id> ACTION=ACKNOWLEDGE|ESCALATE|REQUEST_SHUTDOWN|FALSE_POSITIVE)
	@test -n "$(REPORT)" || { echo "REPORT=<report id> is required — see 'make verify' or the dashboard"; exit 1; }
	@curl -s -X POST $(DASHBOARD)/api/decision -H 'content-type: application/json' \
		-d '{"reportId":"$(REPORT)","b":"$(BOILER)","action":"$(ACTION)","note":"$(NOTE)"}' \
		| jq -r 'if .error then "failed: \(.error)" else "published as decisions message \(.sequenceNumber)" end'

e2e: ## Full run: start the worker, drive one fault through it, verify on chain
	@echo "→ starting worker (log: $(PIPELINE_LOG))"
	@npm run pipeline > $(PIPELINE_LOG) 2>&1 & echo $$! > /tmp/boiler-pipeline.pid
	@sleep $(SETTLE)
	@echo "→ simulating $(FAULT) for $(DURATION)s, fault at t+$(START)s"
	@$(MAKE) --no-print-directory sim || true
	@echo "→ draining $(DRAIN)s for classifications and reports"
	@sleep $(DRAIN)
	@kill -INT $$(cat /tmp/boiler-pipeline.pid) 2>/dev/null || true
	@sleep 8
	@kill -9 $$(cat /tmp/boiler-pipeline.pid) 2>/dev/null || true
	@rm -f /tmp/boiler-pipeline.pid
	@echo
	@cat $(PIPELINE_LOG)
	@echo
	@$(MAKE) --no-print-directory verify

verify: ## Read back the topics from the mirror node
	@set -a; source .env; set +a; \
	echo "telemetry $$TOPIC_TELEMETRY — last 3 frames"; \
	curl -s "$(MIRROR)/topics/$$TOPIC_TELEMETRY/messages?limit=3&order=desc" \
		| jq -r '.messages[] | "  hcs#\(.sequence_number)  \(.message|@base64d)"'; \
	echo "analysis $$TOPIC_ANALYSIS — last 8, oldest first"; \
	curl -s "$(MIRROR)/topics/$$TOPIC_ANALYSIS/messages?limit=8&order=desc" \
		| jq -r '[.messages[] | (.message|@base64d|fromjson) as $$m | "  hcs#\(.sequence_number)  \($$m.kind)  \($$m.severity // ("urgency=" + ($$m.urgency|tostring)))  ref=\($$m.ref.from)-\($$m.ref.to)  \($$m.method // $$m.pattern // $$m.state)"] | reverse | .[]'; \
	echo "reports $$TOPIC_REPORTS"; \
	curl -s "$(MIRROR)/topics/$$TOPIC_REPORTS/messages?limit=100&order=desc" \
		| jq -r '[.messages[] | .chunk_info.initial_transaction_id.transaction_valid_start // (.sequence_number|tostring)] | unique | length as $$n | "  \($$n) report(s) on topic — each spans several chunks; read them on the dashboard"'

typecheck: ## Type-check the worker and build the dashboard
	npx tsc --noEmit
	npm run build --workspace web

test: ## Run unit tests
	npm test

build: ## Compile the worker to dist/
	npm run build

clean: ## Remove build output
	rm -rf dist web/.next
