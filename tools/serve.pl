#!/usr/bin/perl
# Minimal static file server for the Sauna Conductor (fallback when Python is missing).
# Usage: perl tools/serve.pl 8888 .
use strict;
use warnings;
use IO::Socket::INET;

my $port = shift || 8888;
my $root = shift || '.';
my %types = (
  html => 'text/html; charset=utf-8', js => 'text/javascript; charset=utf-8',
  css => 'text/css; charset=utf-8', json => 'application/json', md => 'text/plain; charset=utf-8',
  mp3 => 'audio/mpeg', wav => 'audio/wav', m4a => 'audio/mp4', ogg => 'audio/ogg',
  svg => 'image/svg+xml', png => 'image/png', jpg => 'image/jpeg', ico => 'image/x-icon',
);

my $srv = IO::Socket::INET->new(
  LocalAddr => '127.0.0.1', LocalPort => $port, Listen => 16, ReuseAddr => 1,
) or die "Cannot listen on port $port: $!\n";
print "Serving $root on http://127.0.0.1:$port/\n";

while (my $c = $srv->accept) {
  $c->autoflush(1);
  my $req = <$c>;
  if (!defined $req) { close $c; next; }
  while (my $h = <$c>) { last if $h =~ /^\r?\n$/; }
  my ($method, $path) = $req =~ m{^(GET|HEAD)\s+(\S+)};
  if (!$method) { print $c "HTTP/1.0 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n"; close $c; next; }
  $path =~ s/[?#].*//;
  $path =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
  $path .= 'index.html' if $path =~ m{/$};
  if ($path =~ /\.\./) { print $c "HTTP/1.0 403 Forbidden\r\nContent-Length: 0\r\n\r\n"; close $c; next; }
  my $file = $root . $path;
  if (-f $file && open(my $fh, '<:raw', $file)) {
    my ($ext) = $file =~ /\.(\w+)$/;
    my $type = $types{lc($ext // '')} // 'application/octet-stream';
    my $size = -s $file;
    print $c "HTTP/1.0 200 OK\r\nContent-Type: $type\r\nContent-Length: $size\r\nCache-Control: no-store\r\n\r\n";
    if ($method eq 'GET') { local $/ = \65536; while (my $buf = <$fh>) { print $c $buf; } }
    close $fh;
  } else {
    print $c "HTTP/1.0 404 Not Found\r\nContent-Length: 0\r\n\r\n";
  }
  close $c;
}
