---
layout: post
title: "The address field that stayed blank"
permalink: /notes/traefik-clusterip-ingress-status/
categories: [kubernetes, networking]
excerpt: "Traefik worked fine on a ClusterIP service, but every Ingress came out with an empty Address and ArgoCD never stopped waiting. The cause was one loop with nothing to iterate."
---

The first time I saw this in the wild was in an IPv6-only cluster. Traefik was exposed with a plain ClusterIP service, which sounds wrong until you remember that in an IPv6-only setup the cluster IP can be fully routable. Traffic flowed, TLS terminated, everything worked. And yet every Ingress object came out with an empty `Address` field, which made ArgoCD treat each one as permanently unfinished. Sync succeeded, health never settled.

The annoying part was that ingress-nginx, running in the same cluster on the same kind of service, filled the field in without any fuss. So this wasn't a Kubernetes quirk. Traefik was choosing to say nothing.

## Where the address is supposed to come from

Traefik's Kubernetes Ingress provider has a `publishedService` option. Point it at the service that fronts Traefik and Traefik copies that service's address into `status.loadBalancer.ingress` on every Ingress it owns. That's the field kubectl shows as `Address`, and it's what external-dns, ArgoCD, and friends read to decide whether an Ingress is "done."

The copying logic lives in `updateIngressStatus` in `pkg/provider/kubernetes/ingress/kubernetes.go`, and it branches on the service type. LoadBalancer services donate their `loadBalancer.status` endpoints. NodePort services get the nodes' external IPs. ClusterIP services, at least in theory, got their `externalIPs` propagated.

In theory, because here's the ClusterIP branch as it was:

```go
for _, ip := range service.Spec.ExternalIPs {
    ingressStatus = append(ingressStatus, netv1.IngressLoadBalancerIngress{
        IP:    ip,
        Ports: ports,
    })
}
```

Nothing crashes here. That's what makes it nasty. An ordinary ClusterIP service has no `externalIPs` — the field exists, but it's an empty slice, and a `for` over an empty slice is a no-op. So `ingressStatus` stays empty, the status update writes an empty list, and the Ingress's `Address` renders blank. The code doesn't fail to find the address; it never looks anywhere else.

## The fallback that was missing

The fix, which landed in traefik/traefik#13357, keeps the externalIPs behavior intact and adds the fallback nginx-ingress already had: when the service has no external IPs but does have a cluster IP, publish the cluster IP.

```go
if len(service.Spec.ExternalIPs) > 0 {
    for _, ip := range service.Spec.ExternalIPs {
        ingressStatus = append(ingressStatus, netv1.IngressLoadBalancerIngress{
            IP:    ip,
            Ports: ports,
        })
    }
} else if service.Spec.ClusterIP != "" && service.Spec.ClusterIP != "None" {
    // The ClusterIP is published when the service has no externalIPs,
    // because in some clusters the ClusterIP is routable.
    ingressStatus = append(ingressStatus, netv1.IngressLoadBalancerIngress{
        IP:    service.Spec.ClusterIP,
        Ports: ports,
    })
}
```

Two details in that `else if` earn their keep. The `!= "None"` check is the headless sentinel: a headless service literally has `clusterIP: None`, no virtual IP exists, and publishing the string "None" as an address would be worse than publishing nothing. And ordering matters — externalIPs still win when both are set. If someone went to the trouble of declaring external IPs, those are the addresses they want advertised; the cluster IP is a fallback, not an override.

The alternative I considered and rejected was copying the ClusterIP unconditionally and appending externalIPs on top. That would have changed what existing setups publish, and the status field is an outward contract: external-dns turns it into DNS records. Silently adding an extra address to every ClusterIP-backed Ingress is the kind of change that gets your name remembered for the wrong reasons.

## What the tests pin down

The test additions are small but they cover the three shapes a ClusterIP service can take. A new fixture describes a service with `clusterIP: 10.0.0.99` and no externalIPs, and the expected status is exactly that address, with both service ports attached. A second fixture sets `clusterIP: None` — headless — and expects the status to stay empty, locking in the sentinel behavior.

The most subtle change is one line in an existing fixture. The pre-existing ClusterIP test, which expects externalIPs `1.2.3.4` and `5.6.7.8` in the status, gained a `clusterIP: 10.0.0.99`. That line is there to prove precedence: with both fields populated, the published addresses are still the externalIPs, and the cluster IP stays quiet. Without it, a future refactor that accidentally prefers the cluster IP would pass every test.

There's also a documentation update, and it doesn't just describe the new behavior — it warns about it. A cluster IP may only be reachable from inside the cluster, so if external-dns is generating records from ingress status, those records can point at an address outside clients can't resolve. The fallback is right for the IPv6-only case that motivated it, where the cluster IP is routable, but it's not free of consequences for everyone else.

## Who actually hits this

Anyone running Traefik with `publishedService` pointing at a ClusterIP service and no `externalIPs` — which is the default shape of that service — gets a blank `Address` on every Ingress. Most people never notice because nothing they use reads the field. The ones who do notice are running GitOps tooling or DNS automation on top of ingress status, and for them the blank field isn't cosmetic; it's a stuck sync or a missing record. In IPv6-only clusters, where publishing the cluster IP is precisely the correct answer, the old behavior was a straight regression against what nginx-ingress does out of the box.

What I took away from this one: a loop over a slice that happens to be empty is a silent policy decision. Kubernetes API objects are full of optional list fields, and "iterate the list" only works if the list is the thing you actually want to publish. When the list is empty, the code should know what that means — here it meant "look one field over," and for years nobody did.
