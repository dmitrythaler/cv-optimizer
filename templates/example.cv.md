[John Dow]{.cv-name}

::: {.contacts}
[john.dow@example.com](mailto:john.dow@example.com) [•]{.sep} [linkedin.com/in/johndow](https://linkedin.com/in/johndow) [•]{.sep} [github.com/johndow](https://github.com/johndow) \
PT: +00-000-000-000 [•]{.sep} Lisbon, Portugal
:::

::: {.summary}
Senior full-stack engineer with a backend focus and 14 years of experience, primarily in Node.js and TypeScript. Much of my work is at the integration layer: bringing disparate external systems together behind reliable GraphQL and REST APIs. This has included payment gateways, freight carrier rate feeds, and analytics platforms processing billions of event records.

I also build front-end features in Vue and React when needed. My broader stack includes PostgreSQL, ClickHouse, Kafka, Redis, AWS, Kubernetes, Terraform and OpenTelemetry. I use LLM tools daily for research, implementation and code review, particularly to understand unfamiliar domains quickly.
:::

## Selected Skills

::: {.skills}
**Backend:** Node.js, TypeScript, JavaScript, GraphQL, REST, OpenAPI/Swagger, Fastify, Express, OAuth, JWT, authentication and authorization, microservices, distributed systems

**Frontend:** Vue, Pinia, React, Redux, HTML, CSS, Tailwind, SCSS

**Data:** PostgreSQL, MongoDB, Redis, Elasticsearch, ClickHouse, SQL and NoSQL modelling, OLAP, high-volume data processing

**Cloud & Infrastructure:** AWS (EKS, ECS/Fargate, RDS, EBS, S3, CloudFront, SNS/SQS, KMS, Lambda, CloudFormation), Kafka, RabbitMQ, Docker, Kubernetes, Terraform, Ansible, Linux, shell scripting, Nomad, Consul, Vault

**Observability & Testing:** OpenTelemetry, Grafana stack, Node native testing, Jest, Playwright, CI/CD, GH Actions, performance monitoring

**AI-Assisted Development:** LLM-assisted research, planning, implementation, cross-model adversarial review, refactoring, testing and documentation

**Integrations:** Payment gateways (Stripe, PayPal, Square), carrier and logistics APIs, trading exchanges, Google APIs, email delivery services (SendGrid, Mandrill), geolocation services (MaxMind), social platform APIs

**Languages:** English (professional working proficiency), Portuguese (elementary)
:::

## Selected Professional Experience

::: {.entry}
### **Tessellate Labs** - *Senior Full-Stack Engineer*

**Jan 2024 - Present**

* Build the reporting layer of a multi-tenant analytics product, with churn and cohort queries running over roughly two billion event rows.
* Own the Node.js and TypeScript GraphQL gateway and the Vue front end, with ClickHouse-backed OLAP services in a microservices architecture.
* Reduced p95 dashboard load from 11s to under 900ms by moving aggregation out of the request path into pre-materialised rollups.
* Introduced LLM-assisted code review to the team and maintain the prompt library it uses.
:::

::: {.entry}
### **Halcyon Freight** - *Senior Back-End Developer*

**Apr 2022 - Dec 2023**

* Owned the pricing and quoting services of a freight marketplace, normalising carrier rate sheets from a dozen incompatible formats behind one stable REST API.
* Built the canonical data model in PostgreSQL and propagated changes through Kafka.
* Implemented autoscaling that provisioned short-lived, high-memory workers for overnight re-pricing, holding cloud spend flat while volume tripled.
* Owned infrastructure work with Terraform, Docker, OpenTelemetry and a Nomad and Consul estate.
:::

::: {.entry}
### **Marrowbone Interactive** - *Senior Back-End Developer*

**Sep 2020 - Mar 2022**

* Built the session service for a live multiplayer quiz platform, holding up to 40,000 concurrent players per round over WebSockets.
* Used Redis for presence and scoring, and MongoDB for question banks.
* Wrote the load harness that proved the concurrency ceiling before each tournament.
* Deployed on AWS with ECS/Fargate and SNS/SQS.
:::

::: {.entry}
### **Brightwell Payments** - *Senior Back-End Developer*

**Feb 2018 - Aug 2020**

* Built and maintained payment gateway adapters for Stripe, PayPal, Square and two national banking APIs behind a single internal payments API.
* Treated idempotency and reconciliation as first-class design concerns, ending a recurring monthly incident pattern by making retries idempotent end to end.
* Documented the API with OpenAPI/Swagger and carried the on-call rotation for those services.
* Used Node.js, TypeScript, PostgreSQL, RabbitMQ and AWS RDS and KMS.
:::

::: {.entry}
### **Lattice Networks** - *Back-End Developer*

**May 2016 - Jan 2018**

* Extended a platform for monitoring and diagnostics of multi-level, multi-protocol computer networks.
* Migrated the primary store from ArangoDB to PostgreSQL without downtime.
* Used Node.js, TypeScript, Express and a microservices architecture.
:::

::: {.entry}
### **Nine Mile Media** - *Full-Stack Developer*

**Jun 2013 - Apr 2016**

* Built the editorial and publishing tools for a regional news group, including an article workflow with scheduled release and a media pipeline for images and video.
* Delivered the public-facing site with React and Redux, backed by PostgreSQL and Elasticsearch.
* Moved the newsroom off a shared FTP deployment onto a CI pipeline.
* Used Node.js, Express, React, PostgreSQL and Elasticsearch.
:::
