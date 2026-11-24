resource "aws_s3_bucket" "data_bucket" {
  bucket = "company-sensitive-data"
  acl    = "private"

  tags = {
    Environment = "production"
  }
}

resource "aws_s3_bucket_acl" "data_bucket_acl" {
  bucket = aws_s3_bucket.data_bucket.id
  acl    = "private"
}
