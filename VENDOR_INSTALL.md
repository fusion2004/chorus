# Compiling and installing vendor libraries

```shell
docker run -it --name thasauce-build heroku/heroku:18-build bash

mkdir /app
cd /app

apt-get update
apt-get install libsndfile1 libsndfile1-dev libmad0 libmad0-dev libmp3lame0 libmp3lame-dev
wget https://sourceforge.net/projects/sox/files/sox/14.4.2/sox-14.4.2.tar.gz/download -O sox-14.4.2.tar.gz
tar xzf sox-14.4.2.tar.gz
cd sox-14.4.2
./configure --prefix=/app/vendor/sox
make -s
make install

cd /app
tar czf sox-vendor-14.4.2.tar.gz vendor/sox/

# In another terminal
docker cp thasauce-build:/app/sox-vendor-14.4.2.tar.gz .

# In original terminal
exit
docker rm thasauce-build

# Host them on S3, and add them to .vendor_urls
```
