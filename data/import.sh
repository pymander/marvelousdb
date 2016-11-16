#!/bin/bash
#
# Import raw JSON files into MongoDB
# Run this on the MongoDB server!

for file in characters/*.json
do
    echo Importing $file
    mongoimport -d marvel -c characters --type json --jsonArray --file $file
done

for file in comics/*.json
do
    echo Importing $file
    mongoimport -d marvel -c comics --type json --jsonArray --file $file
done


