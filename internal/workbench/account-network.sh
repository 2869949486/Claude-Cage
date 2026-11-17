set -euo pipefail
id=$1
[[ $id =~ ^[0-9a-f]{24}$ ]]
ns="net-$id"
exec 9>/run/account-network.lock
flock -w 20 9
if ! test -e "/run/netns/$ns"; then
  ip netns add "$ns"
  trap 'ip netns del "$ns"' ERR
  ip -n "$ns" link set lo up
  ip netns exec "$ns" sysctl -qw net.ipv4.ip_unprivileged_port_start=0
  ip -n "$ns" link add uplink type dummy
  ip -n "$ns" address add 192.0.2.1/32 dev uplink
  ip -n "$ns" link set uplink up
  ip -n "$ns" route add default dev uplink
  ip netns exec "$ns" sysctl -qw net.ipv6.conf.all.disable_ipv6=1
  # No veth, physical interface, or NAT route out of the namespace. Every
  # external TCP connection is intercepted; unhandled protocols go nowhere.
  ip netns exec "$ns" iptables -t nat -A OUTPUT ! -d 127.0.0.0/8 -p tcp -j REDIRECT --to-ports 15301
  trap - ERR
fi
install -d -m 0755 "/etc/netns/$ns"
printf 'nameserver 127.0.0.1\noptions attempts:1 timeout:4\n' >"/etc/netns/$ns/resolv.conf"
# This helper is used as BROWSER by bound terminal sessions. It can only
# reach the matching Desktop's display. Keep the authorization URL off sudo argv.
dir="/usr/local/lib/account-routes/$id"
install -d -m 0755 "$dir"
cat >"$dir/open" <<'OPEN'
#!/bin/bash
set -eu
id=${0%/open}; id=${id##*/}
[[ $id =~ ^[a-f0-9]{24}$ ]]
if [[ ${1:-} == --stdin ]]; then url=$(cat); else url=${1:-}; fi
[[ $url == https://* && $url != *[[:space:]]* && ${#url} -le 8192 ]] || exit 2
fifo="/run/desktop-$id/authorization"
[[ -p $fifo ]] || { echo '请先打开该账号的 Desktop。' >&2; exit 1; }
# Serialize writers for URLs longer than PIPE_BUF.
printf '%s\n' "$url" | timeout 5 flock -w 4 "/run/desktop-$id" tee "$fifo" >/dev/null
OPEN
chmod 0755 "$dir/open"
