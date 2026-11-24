resource "aws_ebs_volume" "database_data" {
  availability_zone = "us-east-1a"
  size              = 100
  encrypted         = false

  tags = {
    Name = "unencrypted-db-volume"
  }
}

resource "aws_db_instance" "postgres" {
  allocated_storage = 50
  engine            = "postgres"
  storage_encrypted = false
}
