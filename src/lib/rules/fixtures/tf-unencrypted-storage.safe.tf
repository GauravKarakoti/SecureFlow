resource "aws_ebs_volume" "database_data" {
  availability_zone = "us-east-1a"
  size              = 100
  encrypted         = true
  kms_key_id        = "arn:aws:kms:us-east-1:123456789012:key/my-key"

  tags = {
    Name = "encrypted-db-volume"
  }
}

resource "aws_db_instance" "postgres" {
  allocated_storage = 50
  engine            = "postgres"
  storage_encrypted = true
}
