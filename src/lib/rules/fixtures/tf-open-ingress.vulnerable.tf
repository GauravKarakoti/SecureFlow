resource "aws_security_group" "web" {
  name        = "web-sg"
  description = "Web security group"
  vpc_id      = "vpc-123456"

  ingress {
    description = "Open SSH access"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
