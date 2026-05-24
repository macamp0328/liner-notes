# VPC + networking for the single-node k3s instance.
#
# Single AZ, single public subnet. No NAT gateway — the node has a public IP
# and routes egress directly through the internet gateway. This matches the
# single-node, personal-project scale and keeps cost at $0 for networking.

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${local.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-igw"
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name_prefix}-public"
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "k3s_node" {
  name        = "${local.name_prefix}-k3s-node"
  description = "Inbound rules for the graph-service k3s node."
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-k3s-node"
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_nodeport" {
  for_each = toset(var.allow_app_cidr)

  security_group_id = aws_security_group.k3s_node.id
  description       = "graph-service NodePort"
  cidr_ipv4         = each.value
  from_port         = 30080
  to_port           = 30080
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each = toset(var.allow_ssh_cidr)

  security_group_id = aws_security_group.k3s_node.id
  description       = "SSH"
  cidr_ipv4         = each.value
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.k3s_node.id
  description       = "All egress"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
